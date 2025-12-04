import { GelatoRelay, type CallWithSyncFeeRequest } from "@gelatonetwork/relay-sdk";
import { encodeFunctionData, type Abi, type Address } from "viem";
import {
  buildPermitSignature,
  getArgValue,
  makeClients,
  parseNumber,
  requireEnv,
  retry,
  waitForTaskFinal,
} from "./relayHelpers";

const PERMIT_SWAP_ABI = [
  {
    name: "incrementWithPermitFeeCapped",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "user", type: "address" },
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
      { name: "maxFee", type: "uint256" },
    ],
    outputs: [],
  },
] as const satisfies Abi;

async function main() {
  const { account, publicClient, chainId } = makeClients();

  const target = requireEnv("PERMIT_SWAP_PAY_FEE_NATIVE") as Address;
  const token = (process.env.PERMIT_TOKEN ?? process.env.USDC) as Address | undefined;
  if (!token) {
    throw new Error("Set PERMIT_TOKEN or USDC in .env");
  }

  const feeToken = (process.env.FEE_TOKEN ?? token) as Address | undefined;
  if (!feeToken) {
    throw new Error("Set FEE_TOKEN or PERMIT_TOKEN/USDC in .env");
  }

  const sponsorApiKey = requireEnv("GELATO_RELAY_API_KEY");
  const amountInput = process.env.AMOUNT ?? "1";
  const permitDeadline = BigInt(process.env.PERMIT_DEADLINE ?? Math.floor(Date.now() / 1000 + 60 * 30));
  const gasLimit = BigInt(process.env.GAS_LIMIT ?? 400_000);
  const feeBufferBps = BigInt(process.env.FEE_BUFFER_BPS ?? "2000");
  const isHighPriority = process.env.GELATO_HIGH_PRIORITY === "true";
  const relayRetries = parseNumber(process.env.RELAY_RETRIES, 3);
  const relayRetryDelayMs = parseNumber(process.env.RELAY_RETRY_DELAY_MS, 1500);
  const statusMaxAttempts = parseNumber(process.env.STATUS_POLL_MAX_ATTEMPTS, 20);
  const statusIntervalMs = parseNumber(process.env.STATUS_POLL_INTERVAL_MS, 5000);

  const taskIdFromArgs = getArgValue("--task") ?? process.env.TASK_ID;
  const relay = new GelatoRelay();

  if (taskIdFromArgs) {
    console.log(`Fetching status for taskId=${taskIdFromArgs}`);
    await waitForTaskFinal(relay, taskIdFromArgs, statusMaxAttempts, statusIntervalMs);
    return;
  }

  const permitSig = await buildPermitSignature({
    publicClient,
    signer: account,
    owner: account.address,
    token,
    spender: target,
    amountInput,
    permitDeadline,
    chainId,
  });

  const estimatedFee = await relay.getEstimatedFee(chainId, feeToken, gasLimit, isHighPriority);
  const maxFee = (estimatedFee * (10_000n + feeBufferBps)) / 10_000n;

  const data = encodeFunctionData({
    abi: PERMIT_SWAP_ABI,
    functionName: "incrementWithPermitFeeCapped",
    args: [account.address, token, permitSig.amount, permitDeadline, permitSig.v, permitSig.r, permitSig.s, maxFee],
  });

  const request: CallWithSyncFeeRequest = {
    chainId,
    target,
    data,
    feeToken,
    isRelayContext: true,
  };

  console.log("Submitting callWithSyncFee:", {
    chainId: chainId.toString(),
    target,
    token,
    feeToken,
    amount: permitSig.amount.toString(),
    permitDeadline: permitDeadline.toString(),
    gasLimit: gasLimit.toString(),
    maxFee: maxFee.toString(),
  });

  const { taskId } = await retry(
    () => relay.callWithSyncFee(request, { gasLimit }, sponsorApiKey),
    relayRetries,
    relayRetryDelayMs
  );
  console.log(`Gelato task submitted. taskId=${taskId}`);
  await waitForTaskFinal(relay, taskId, statusMaxAttempts, statusIntervalMs);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
