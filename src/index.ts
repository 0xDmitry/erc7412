import * as viem from "viem";
import IERC7412 from "../out/IERC7412.sol/IERC7412.json";
import { Adapter } from "./adapter";

export { Adapter } from "./adapter";
export { DefaultAdapter } from "./adapters/default";

type TransactionRequest = Pick<
  viem.TransactionRequest,
  "to" | "data" | "value"
>;

export class EIP7412 {
  adapters: Map<string, Adapter>;
  multicallFunc: (txs: TransactionRequest[]) => TransactionRequest;

  constructor(
    adapters: Adapter[],
    multicallFunc: (txs: TransactionRequest[]) => TransactionRequest
  ) {
    this.adapters = new Map();
    adapters.forEach((adapter) => {
      this.adapters.set(adapter.getOracleId(), adapter);
    });
    this.multicallFunc = multicallFunc;
  }

  async enableERC7412(
    client: viem.PublicClient,
    tx: TransactionRequest
  ): Promise<TransactionRequest> {
    let multicallCalls: TransactionRequest[] = [tx];
    while (true) {
      try {
        const multicallTxn = this.multicallFunc(multicallCalls);
        await client.call(multicallTxn);
        return multicallTxn;
      } catch (error) {
        const err = viem.decodeErrorResult({
          abi: IERC7412.abi,
          data: ((error as viem.CallExecutionError).cause as any).cause.error
            .data as viem.Hex, // A configurable or generalized solution is needed for finding the error data
        });
        if (err.errorName === "OracleDataRequired") {
          const oracleQuery = err.args![1] as viem.Hex;
          const oracleAddress = err.args![0] as viem.Address;

          const oracleId = viem.hexToString(
            viem.trim(
              (await client.readContract({
                abi: IERC7412.abi,
                address: oracleAddress,
                functionName: "oracleId",
                args: [],
              })) as unknown as viem.Hex,
              { dir: "right" }
            )
          );

          const adapter = this.adapters.get(oracleId);
          if (adapter === undefined) {
            throw new Error(
              `oracle ${oracleId} not supported (supported oracles: ${Array.from(
                this.adapters.keys()
              ).join(",")})`
            );
          }

          const signedRequiredData = await adapter.fetchOffchainData(
            client,
            oracleAddress,
            oracleQuery
          );

          multicallCalls.splice(multicallCalls.length - 1, 0, {
            to: err.args![0] as viem.Address,
            data: viem.encodeFunctionData({
              abi: IERC7412.abi,
              functionName: "fulfillOracleQuery",
              args: [oracleQuery, signedRequiredData],
            }),
          });
        } else if (err.errorName === "FeeRequired") {
          const requiredFee = err.args![0] as bigint;
          multicallCalls[multicallCalls.length - 2].value = requiredFee;
        } else {
          throw error;
        }
      }
    }
  }
}
