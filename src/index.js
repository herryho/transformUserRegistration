const { ApiPromise, WsProvider, Keyring } = require("@polkadot/api");
const { ethAddressFromDelegated } = require("@glif/filecoin-address");
const { hexToString, isHex, u8aToHex } = require("@polkadot/util");
const { cryptoWaitReady, sortAddresses } = require("@polkadot/util-crypto");
const { decodeAddress, encodeAddress } = require("@polkadot/keyring");
const fs = require("fs");
require("dotenv").config();

const FIL_CURRENCY_ID = { Token2: 4 };

async function getBifrostApi(endpoint) {
  const wsProvider = new WsProvider(endpoint);
  const api = await ApiPromise.create({ provider: wsProvider });

  await cryptoWaitReady();

  return api;
}

async function getRegisteredData() {
  // 这个用的是升级前网络的api
  const wss = process.env.BIFROST_ENDPOINT;
  const api = await getBifrostApi(wss);

  // 获取所有CrossInOut模块里的accountToOuterMultilocation的key为{token2: 4}存储条目
  const accountToOuterMultilocation =
    await api.query.crossInOut.accountToOuterMultilocation.entries({
      token2: 4,
    });

  console.log(JSON.stringify(accountToOuterMultilocation));

  let accountPairList = [];
  // 获得了数据之后，调整数据格式，每50条发batch交易给bifrost node
  for (const [
    accountInfo,
    filcoinMultilocationRaw,
  ] of accountToOuterMultilocation) {
    let filcoinMultilocation = JSON.parse(
      JSON.stringify(filcoinMultilocationRaw)
    );
    // 先将generalKey转换成f410地址
    let filecoin_account = hexToString(
      filcoinMultilocation.interior.x1.generalKey
    );

    // 然后再将f410地址转换成0x开头的地址
    filecoin_account = ethAddressFromDelegated(filecoin_account);

    const {
      args: [currencyId, bifrostAccount],
    } = accountInfo;

    console.log(`currencyId: ${currencyId}`);
    console.log(`bifrostAccount: ${bifrostAccount}`);

    let accountPair = {
      filecoinAccount: filecoin_account,
      bifrostAccount: bifrostAccount,
    };

    accountPairList.push(accountPair);
  }

  return accountPairList;
}

function readJsonFile(filename) {
  // 读取项目根目录下的json文件
  const data = fs.readFileSync(filename, "utf-8");
  return JSON.parse(data);
}

async function main() {
  // const data = await getRegisteredData();

  const data = readJsonFile("./1.json");
  // console.log(JSON.stringify(data));

  // 暂时先comment掉，用测试网地址
  const endpoint = process.env.BIFROST_ENDPOINT;
  const bifrostApi = await getBifrostApi(endpoint);

  let transactionList = [];
  // 获得了数据之后，调整数据格式，每50条发batch交易给bifrost node
  for (const { bifrostAccount, filecoinAccount } of data) {
    // If both signature valid, link the bifrost and filecoin accounts in the Bifrost chain.
    const registerTransaction = getRegisterLinkedAccountTransaction(
      bifrostAccount,
      filecoinAccount,
      bifrostApi
    );
    transactionList.push(registerTransaction);
  }

  console.log(`transactionList: ${JSON.stringify(transactionList)}`);

  let batchedTx = getBatchedTransaction(transactionList, bifrostApi);

  const ifMainNode = process.env.MAIN_NODE;

  if (ifMainNode == "YES") {
    await createNewMultisigService(batchedTx, bifrostApi);
    fs.writeFileSync("1.json", JSON.stringify(data));
  } else {
    await approveMultisigService(batchedTx, bifrostApi);
  }

  console.log("Done with multisig");
}

// filecoin_account是0x开头的以太坊地址
function getRegisterLinkedAccountTransaction(
  bifrost_account,
  filecoin_account,
  bifrostApi
) {
  const filecoin_multilocation =
    getFilecoinUserAccountMultilocation(filecoin_account);

  const registerTransaction = bifrostApi.tx.crossInOut.registerLinkedAccount(
    FIL_CURRENCY_ID,
    bifrost_account,
    filecoin_multilocation
  );

  return registerTransaction;
}

// 返回transaction hash
async function createNewMultisigService(call, bifrostApi) {
  return new Promise(async (resolve, reject) => {
    try {
      const encoded_call = call.method.toHex();
      const bifrostSenderKeyring = await getBifrostKeyring();
      const info = await call.paymentInfo(bifrostSenderKeyring);

      const othersigs = getBifrostMultiSigOtherAddresses();
      const threshold = Number(process.env.BIFROST_MULTISIG_THRESHOLD);

      const multisigTx = await bifrostApi.tx.multisig.asMulti(
        threshold,
        othersigs,
        null,
        encoded_call,
        [info.weight.refTime.toString(), info.weight.proofSize.toString()]
      );

      // 签名发出并监控消息的结果
      const txHash = await sendOutTransaction(multisigTx);
      resolve(txHash);
    } catch (e) {
      console.log(`Failed: createNewMultisigService: ${e}`);
      reject(e);
    }
  });
}

async function approveMultisigService(call, bifrostApi) {
  return new Promise(async (resolve, reject) => {
    try {
      let txHashResult = null;
      const toApproveEncodedCall = call.method.toHex();
      const toApproveCallHash = call.method.hash.toString();
      const bifrostSenderKeyring = await getBifrostKeyring();

      const toApproveCallWeight = (await call.paymentInfo(bifrostSenderKeyring))
        .weight;

      const addrMix = process.env.BIFROST_MULTISIG_ADDRESS;
      const otherSigs = getBifrostMultiSigOtherAddresses();
      const threshold = Number(process.env.BIFROST_MULTISIG_THRESHOLD);

      // 从链上获取待同意的多签交易，看看有没有我们要批准的交易
      const callHashList = await bifrostApi.query.multisig.multisigs.keys(
        addrMix
      );

      console.log(`callHashList: ${JSON.stringify(callHashList)}`);

      for (const {
        args: [, callHashU8a],
      } of callHashList) {
        if (callHashU8a == toApproveCallHash) {
          const multisigInfoOption = await bifrostApi.query.multisig.multisigs(
            addrMix,
            callHashU8a
          );

          const multisigInfo = multisigInfoOption.unwrapOr(null);
          if (multisigInfo) {
            const { approvals } = multisigInfo;
            // 如果我们要同意的call已经发上去了，且还没同意过，就去同意。没有的话，就什么也不干。
            const bifrostSignerAccount = process.env.SIGNER_ADDRESS;

            if (approvals.length && !approvals.includes(bifrostSignerAccount)) {
              const { height, index } = multisigInfo["when"];
              // 构造approve Multisig的交易
              const paras = [
                threshold,
                otherSigs,
                { height, index },
                toApproveEncodedCall,
                [
                  toApproveCallWeight.refTime.toString(),
                  toApproveCallWeight.proofSize.toString(),
                ],
              ];

              const multisigTx = bifrostApi.tx.multisig.asMulti(...paras);

              // 签名发出并监控消息的结果
              txHashResult = await sendOutTransaction(multisigTx);
              break;
            }
          }
        }
      }
      resolve(txHashResult);
    } catch (e) {
      console.log(` Failed: approveMultisigService: ${e}`);
      reject(e);
    }
  });
}

function getFilecoinUserAccountMultilocation(filecoin_account) {
  const filecoin_multilocation = {
    // parents = 100 means two chains are not connected to each other.
    parents: 100,
    interior: {
      X1: {
        AccountKey20: { network: null, key: filecoin_account },
      },
    },
  };

  return filecoin_multilocation;
}

function getBifrostMultiSigOtherAddresses() {
  let addresses = sortAddresses(
    process.env.BIFROST_OTHER_SIGNATORIES.split("|")
      .map((addr) => (isHex(addr) ? addr : u8aToHex(decodeAddress(addr))))
      .map((hex) => encodeAddress(hex, 6)),
    6
  );

  const senderAddr = process.env.SIGNER_ADDRESS;
  return addresses.filter((addr) => addr != senderAddr);
}

async function sendOutTransaction(transaction) {
  const bifrostSenderKeyring = await getBifrostKeyring();
  return new Promise(async (resolve, reject) => {
    try {
      const unsub = await transaction.signAndSend(
        bifrostSenderKeyring,
        async ({ status, dispatchError, txHash }) => {
          if (status.isInBlock || status.isFinalized) {
            if (dispatchError != undefined) {
              console.log(`Failed: Send extrinsic: ${dispatchError}`);
              console.log(
                `Failed: Send multisig::newsig extrinsic(): ${status.asInBlock}`
              );
            } else {
              console.log(
                `Succeed: Send extrinsic: \n
              transaction hash: ${txHash} \n
              Block Hash: ${status.asInBlock}`
              );
            }

            // 入块了就取消订阅
            unsub();
            resolve(txHash);
          }
        }
      );
    } catch (err) {
      console.log(`Failed: Send extrinsic: ${err}`);
      // 错误信息往上抛
      reject(err);
    }
  });
}

async function getBifrostKeyring() {
  await cryptoWaitReady();
  const keyring = new Keyring({ type: "sr25519" });
  console.log(`process.env.SIGNER_MNEMONIC: ${process.env.SIGNER_MNEMONIC}`);
  const senderKeyring = keyring.addFromUri(process.env.SIGNER_MNEMONIC);
  return senderKeyring;
}

function getBatchedTransaction(transactionList, bifrostApi) {
  const batchedTransactions = bifrostApi.tx.utility.batchAll(transactionList);

  return batchedTransactions;
}

main();
