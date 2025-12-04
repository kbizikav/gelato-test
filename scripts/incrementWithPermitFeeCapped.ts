import "dotenv/config";
import { GelatoRelay, type CallWithSyncFeeRequest } from "@gelatonetwork/relay-sdk";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  parseUnits,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { base } from "viem/chains";
import type { TransactionStatusResponse } from "@gelatonetwork/relay-sdk";
import { privateKeyToAccount } from "viem/accounts";

const NATIVE_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const DEFAULT_CHAIN = base;

const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

const ERC20_PERMIT_ABI = [
  {
    name: "name",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    name: "version",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    name: "nonces",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const satisfies Abi;

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

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing env var: ${name}`);
  }
  return value;
};

type PublicClientType = ReturnType<typeof createPublicClient>;

const readTokenVersion = async (client: PublicClientType, token: Address): Promise<string> => {
  try {
    return await client.readContract({
      address: token,
      abi: ERC20_PERMIT_ABI,
      functionName: "version",
    });
  } catch {
    return "1";
  }
};

const splitSignature = (signature: Hex): { v: number; r: Hex; s: Hex } => {
  const raw = signature.startsWith("0x") ? signature.slice(2) : signature;
  const r = `0x${raw.slice(0, 64)}` as Hex;
  const s = `0x${raw.slice(64, 128)}` as Hex;
  const v = Number.parseInt(raw.slice(128, 130), 16);
  return { v, r, s };
};

const getArgValue = (flag: string): string | undefined => {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
};

const printTaskStatus = (status: TransactionStatusResponse | undefined, taskId: string) => {
  if (!status) {
    console.log(`No status yet for taskId=${taskId}`);
    return;
  }

  const {
    chainId,
    taskState,
    transactionHash,
    executionDate,
    creationDate,
    lastCheckDate,
    lastCheckMessage,
  } = status as TransactionStatusResponse & Record<string, unknown>;

  console.log("Task status", {
    taskId,
    chainId,
    taskState,
    transactionHash,
    creationDate,
    executionDate,
    lastCheckDate,
    lastCheckMessage,
  });

  if (transactionHash) {
    console.log(`Explorer tx: https://basescan.org/tx/${transactionHash}`);
  }
  if (lastCheckMessage) {
    console.log(`Last check message: ${lastCheckMessage}`);
  }
};

const fetchAndReportStatus = async (relay: GelatoRelay, taskId: string) => {
  try {
    const status = await relay.getTaskStatus(taskId);
    printTaskStatus(status, taskId);
  } catch (err) {
    console.error(`Failed to fetch task status for ${taskId}`, err);
  }
};

async function main() {
  const rpcUrl =
    process.env.RPC_URL ?? (process.env.ALCHEMY_KEY ? `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY}` : undefined);
  if (!rpcUrl) {
    throw new Error("Set RPC_URL or ALCHEMY_KEY in .env");
  }

  const target = requireEnv("PERMIT_SWAP_PAY_FEE_NATIVE") as Address;
  const token = (process.env.PERMIT_TOKEN ?? process.env.USDC) as Address | undefined;
  if (!token) {
    throw new Error("Set PERMIT_TOKEN or USDC in .env");
  }

  // Fee token (ERC20) defaults to USDC/PERMIT_TOKEN
  const feeToken = (process.env.FEE_TOKEN ?? token) as Address | undefined;
  if (!feeToken) {
    throw new Error("Set FEE_TOKEN or PERMIT_TOKEN/USDC in .env");
  }

  const privateKey = requireEnv("PRIVATE_KEY") as `0x${string}`;
  const sponsorApiKey = requireEnv("GELATO_RELAY_API_KEY");
  const chainId = BigInt(process.env.CHAIN_ID ?? DEFAULT_CHAIN.id);
  const amountInput = process.env.AMOUNT ?? "1";
  const permitDeadline = BigInt(process.env.PERMIT_DEADLINE ?? Math.floor(Date.now() / 1000 + 60 * 30));
  const gasLimit = BigInt(process.env.GAS_LIMIT ?? 400_000);
  const feeBufferBps = BigInt(process.env.FEE_BUFFER_BPS ?? "2000"); // 20% headroom by default
  const isHighPriority = process.env.GELATO_HIGH_PRIORITY === "true";

  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({ chain: DEFAULT_CHAIN, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain: DEFAULT_CHAIN, transport: http(rpcUrl) });

  const taskIdFromArgs = getArgValue("--task") ?? process.env.TASK_ID;
  const relay = new GelatoRelay();

  // Status-only mode
  if (taskIdFromArgs) {
    console.log(`Fetching status for taskId=${taskIdFromArgs}`);
    await fetchAndReportStatus(relay, taskIdFromArgs);
    return;
  }

  const [tokenName, tokenVersion, decimals, nonce] = await Promise.all([
    publicClient.readContract({ address: token, abi: ERC20_PERMIT_ABI, functionName: "name" }),
    readTokenVersion(publicClient, token),
    publicClient.readContract({ address: token, abi: ERC20_PERMIT_ABI, functionName: "decimals" }),
    publicClient.readContract({ address: token, abi: ERC20_PERMIT_ABI, functionName: "nonces", args: [account.address] }),
  ]);

  const amount = parseUnits(amountInput, decimals);

  const permitMessage = {
    owner: account.address,
    spender: target,
    value: amount,
    nonce,
    deadline: permitDeadline,
  };

  const signature = await walletClient.signTypedData({
    account,
    domain: {
      name: tokenName,
      version: tokenVersion,
      chainId,
      verifyingContract: token,
    },
    types: PERMIT_TYPES,
    primaryType: "Permit",
    message: permitMessage,
  });

  const permitSig = splitSignature(signature);

  // Estimate fee in ERC20 (USDC)
  const estimatedFee = await relay.getEstimatedFee(chainId, feeToken, gasLimit, isHighPriority);
  const maxFee = (estimatedFee * (10_000n + feeBufferBps)) / 10_000n;

  const data = encodeFunctionData({
    abi: PERMIT_SWAP_ABI,
    functionName: "incrementWithPermitFeeCapped",
    args: [account.address, token, amount, permitDeadline, permitSig.v, permitSig.r, permitSig.s, maxFee],
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
    amount: amount.toString(),
    permitDeadline: permitDeadline.toString(),
    gasLimit: gasLimit.toString(),
    maxFee: maxFee.toString(),
  });

  const { taskId } = await relay.callWithSyncFee(request, { gasLimit }, sponsorApiKey);
  console.log(`Gelato task submitted. taskId=${taskId}`);
  await fetchAndReportStatus(relay, taskId);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
