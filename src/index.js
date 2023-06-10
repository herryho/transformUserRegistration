import { ApiPromise, WsProvider, Keyring } from "@polkadot/api";
import { ethAddressFromDelegated } from "@glif/filecoin-address";
import { hexToString } from "@polkadot/util";
import { cryptoWaitReady } from "@polkadot/util-crypto";

const FIL_CURRENCY_ID = { Token2: 4 };

export async function getRegisteredData() {
  const wss = process.env.BIFROST_ENDPOINT;
  const wsProvider = new WsProvider(wss);

  const api = await ApiPromise.create({ provider: wsProvider });

  // 获取所有CrossInOut模块里的accountToOuterMultilocation的key为{token2: 4}存储条目
  const accountToOuterMultilocation =
    await api.query.crossInOut.accountToOuterMultilocation.entries({
      token2: 4,
    });

  console.log(JSON.stringify(accountToOuterMultilocation));

  // 将accountToOuterMultilocation写入json文件
  const fs = require("fs");
  fs.writeFileSync(
    "./ccountToOuterMultilocation.json",
    JSON.stringify(accountToOuterMultilocation)
  );

  return accountToOuterMultilocation;
}

async function main() {
  const data = await getRegisteredData();

  let transactionList = [];
  // 获得了数据之后，调整数据格式，每50条发batch交易给bifrost node
  for (const [bifrostAccount, filcoinMultilocationRaw] of data) {
    let filcoinMultilocation = JSON.parse(
      JSON.stringify(filcoinMultilocationRaw)
    );
    // 先将generalKey转换成f410地址
    let filecoin_account = hexToString(
      filcoinMultilocation.interior.X1.generalKey
    );

    // 然后再将f410地址转换成0x开头的地址
    filecoin_account = ethAddressFromDelegated(filecoin_account);

    // If both signature valid, link the bifrost and filecoin accounts in the Bifrost chain.
    const registerTransaction = getRegisterLinkedAccountTransaction(
      bifrostAccount,
      filecoin_account
    );
    transactionList.push(registerTransaction);
  }

  let batchedTx =
    this.bifrostCallsHandlerService.getBatchedTransaction(transactionList);
  await createNewMultisigService(batchedTx);
}

// filecoin_account是0x开头的以太坊地址
function getRegisterLinkedAccountTransaction(
  bifrost_account,
  filecoin_account
) {
  const filecoin_multilocation =
    getFilecoinUserAccountMultilocation(filecoin_account);

  const registerTransaction =
    this.bifrostApi.tx.crossInOut.registerLinkedAccount(
      FIL_CURRENCY_ID,
      bifrost_account,
      filecoin_multilocation
    );

  return registerTransaction;
}

// 返回transaction hash
async function createNewMultisigService(call) {
  return new Promise(async (resolve, reject) => {
    try {
      const encoded_call = call.method.toHex();
      const info = await call.paymentInfo(this.bifrostSenderKeyring);

      const othersigs = getBifrostMultiSigOtherAddresses();
      const threshold = Number(process.env.BIFROST_MULTISIG_THRESHOLD);

      const multisigTx = await this.bifrostApi.tx.multisig.asMulti(
        threshold,
        othersigs,
        null,
        encoded_call,
        [info.weight.refTime.toString(), "0"]
      );

      // 签名发出并监控消息的结果
      const txHash = await sendOutTransaction(multisigTx);
      resolve(txHash);
    } catch (e) {
      this.logger.error(`Failed: createNewMultisigService: ${e}`);
      reject(e);
    }
  });
}

export function getFilecoinUserAccountMultilocation(filecoin_account) {
  // 如果是f410开始的地址，需要转换成0x开头的地址
  if (filecoin_account.startsWith("f410")) {
    filecoin_account = ethAddressFromDelegated(filecoin_account);
  }

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
  return sortAddresses(
    process.env.BIFROST_OTHER_SIGNATORIES.split("|")
      .map((addr) => (isHex(addr) ? addr : u8aToHex(decodeAddress(addr))))
      .map((hex) => encodeAddress(hex, 6)),
    6
  );
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
              this.logger.log(
                `${date_str()} Failed: Send multisig::newsig extrinsic(): ${
                  status.asInBlock
                }`
              );
            } else {
              this.logger.log(
                `${date_str()} Succeed: Send extrinsic: \n
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
      this.logger.error(`${date_str()} Failed: Send extrinsic: ${err}`);
      // 错误信息往上抛
      reject(err);
    }
  });
}

async function getBifrostKeyring() {
  await cryptoWaitReady();
  const keyring = new Keyring({ type: "sr25519" });
  const senderKeyring = keyring.addFromUri(process.env.SIGNER_MNEMONIC);
  return senderKeyring;
}

main();
