import { GelatoRelay, type CallWithSyncFeeRequest } from "@gelatonetwork/relay-sdk";
import { encodeFunctionData, parseUnits, type Abi, type Address } from "viem";
import {
  NATIVE_TOKEN,
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
    name: "permitSwapAndPayFeeNative",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "p",
        type: "tuple",
        components: [
          { name: "owner", type: "address" },
          { name: "value", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "v", type: "uint8" },
          { name: "r", type: "bytes32" },
          { name: "s", type: "bytes32" },
        ],
      },
      {
        name: "s",
        type: "tuple",
        components: [
          { name: "minEthOut", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      { name: "maxFeeEth", type: "uint256" },
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

  const sponsorApiKey = requireEnv("GELATO_RELAY_API_KEY");
  const amountInput = process.env.AMOUNT ?? "1";
  const permitDeadline = BigInt(process.env.PERMIT_DEADLINE ?? Math.floor(Date.now() / 1000 + 60 * 30));
  const swapDeadline = BigInt(process.env.SWAP_DEADLINE ?? Math.floor(Date.now() / 1000 + 60 * 20));
  const swapMinEthOut = parseUnits(process.env.SWAP_MIN_ETH_OUT ?? "0", 18);
  const gasLimit = BigInt(process.env.GAS_LIMIT ?? 800_000);
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

  // Estimate fee in native ETH
  const estimatedFee = await relay.getEstimatedFee(chainId, NATIVE_TOKEN, gasLimit, isHighPriority);
  const maxFeeEth = (estimatedFee * (10_000n + feeBufferBps)) / 10_000n;

  const data = encodeFunctionData({
    abi: PERMIT_SWAP_ABI,
    functionName: "permitSwapAndPayFeeNative",
    args: [
      {
        owner: account.address,
        value: permitSig.amount,
        deadline: permitDeadline,
        v: permitSig.v,
        r: permitSig.r,
        s: permitSig.s,
      },
      { minEthOut: swapMinEthOut, deadline: swapDeadline },
      maxFeeEth,
    ],
  });

  const request: CallWithSyncFeeRequest = {
    chainId,
    target,
    data,
    feeToken: NATIVE_TOKEN,
    isRelayContext: true,
  };

  console.log("Submitting permitSwapAndPayFeeNative:", {
    chainId: chainId.toString(),
    target,
    token,
    amount: permitSig.amount.toString(),
    permitDeadline: permitDeadline.toString(),
    swapMinEthOut: swapMinEthOut.toString(),
    swapDeadline: swapDeadline.toString(),
    gasLimit: gasLimit.toString(),
    maxFeeEth: maxFeeEth.toString(),
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
