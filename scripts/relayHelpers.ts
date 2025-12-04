import "dotenv/config";
import { GelatoRelay, type TransactionStatusResponse } from "@gelatonetwork/relay-sdk";
import { createPublicClient, createWalletClient, http, parseUnits, type Abi, type Address, type Hex } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

export const DEFAULT_CHAIN = base;
export const NATIVE_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

export const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export const ERC20_PERMIT_ABI = [
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

const explorerByChain: Record<string, string> = {
  "8453": "https://basescan.org",
};

export const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing env var: ${name}`);
  }
  return value;
};

export const getArgValue = (flag: string): string | undefined => {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
};

export type Clients = {
  account: ReturnType<typeof privateKeyToAccount>;
  publicClient: ReturnType<typeof createPublicClient>;
  walletClient: ReturnType<typeof createWalletClient>;
  chainId: bigint;
  rpcUrl: string;
};

export const makeClients = (): Clients => {
  const rpcUrl =
    process.env.RPC_URL ?? (process.env.ALCHEMY_KEY ? `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY}` : undefined);
  if (!rpcUrl) {
    throw new Error("Set RPC_URL or ALCHEMY_KEY in .env");
  }
  const chainId = BigInt(process.env.CHAIN_ID ?? DEFAULT_CHAIN.id);
  const privateKey = requireEnv("PRIVATE_KEY") as `0x${string}`;
  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({ chain: DEFAULT_CHAIN, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain: DEFAULT_CHAIN, transport: http(rpcUrl) });
  return { account, publicClient, walletClient, chainId, rpcUrl };
};

const readTokenVersion = async (client: Clients["publicClient"], token: Address): Promise<string> => {
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

export type PermitMeta = {
  name: string;
  version: string;
  decimals: number;
  nonce: bigint;
};

export const readPermitMetadata = async (
  client: Clients["publicClient"],
  token: Address,
  owner: Address
): Promise<PermitMeta> => {
  const [name, version, decimals, nonce] = await Promise.all([
    client.readContract({ address: token, abi: ERC20_PERMIT_ABI, functionName: "name" }),
    readTokenVersion(client, token),
    client.readContract({ address: token, abi: ERC20_PERMIT_ABI, functionName: "decimals" }),
    client.readContract({ address: token, abi: ERC20_PERMIT_ABI, functionName: "nonces", args: [owner] }),
  ]);
  return { name, version, decimals, nonce };
};

export const splitSignature = (signature: Hex): { v: number; r: Hex; s: Hex } => {
  const raw = signature.startsWith("0x") ? signature.slice(2) : signature;
  const r = `0x${raw.slice(0, 64)}` as Hex;
  const s = `0x${raw.slice(64, 128)}` as Hex;
  const v = Number.parseInt(raw.slice(128, 130), 16);
  return { v, r, s };
};

export type PermitSignatureResult = {
  amount: bigint;
  v: number;
  r: Hex;
  s: Hex;
  decimals: number;
};

export const buildPermitSignature = async (params: {
  publicClient: Clients["publicClient"];
  signer: PrivateKeyAccount;
  owner: Address;
  token: Address;
  spender: Address;
  amountInput: string;
  permitDeadline: bigint;
  chainId: bigint;
}): Promise<PermitSignatureResult> => {
  const { publicClient, signer, owner, token, spender, amountInput, permitDeadline, chainId } = params;
  const meta = await readPermitMetadata(publicClient, token, owner);
  const amount = parseUnits(amountInput, meta.decimals);
  const signature = await signer.signTypedData({
    domain: {
      name: meta.name,
      version: meta.version,
      chainId,
      verifyingContract: token,
    },
    types: PERMIT_TYPES,
    primaryType: "Permit",
    message: {
      owner,
      spender,
      value: amount,
      nonce: meta.nonce,
      deadline: permitDeadline,
    },
  });
  const { v, r, s } = splitSignature(signature as Hex);
  return { amount, v, r, s, decimals: meta.decimals };
};

export const printTaskStatus = (status: TransactionStatusResponse | undefined, taskId: string) => {
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

  const explorer = chainId ? explorerByChain[String(chainId)] : undefined;
  if (transactionHash && explorer) {
    console.log(`Explorer tx: ${explorer}/tx/${transactionHash}`);
  }
  if (lastCheckMessage) {
    console.log(`Last check message: ${lastCheckMessage}`);
  }
};

export const fetchAndReportStatus = async (relay: GelatoRelay, taskId: string) => {
  try {
    const status = await relay.getTaskStatus(taskId);
    printTaskStatus(status, taskId);
  } catch (err) {
    console.error(`Failed to fetch task status for ${taskId}`, err);
  }
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const retry = async <T>(fn: () => Promise<T>, maxRetries = 3, delayMs = 1500): Promise<T> => {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxRetries) break;
      console.warn(`Retrying (${attempt + 1}/${maxRetries}) after error: ${(err as Error).message ?? err}`);
      await sleep(delayMs);
    }
  }
  throw lastErr;
};

export const parseNumber = (value: string | undefined, fallback: number): number => {
  const n = value === undefined ? Number.NaN : Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const TERMINAL_STATES = new Set([
  "ExecSuccess",
  "ExecReverted",
  "Cancelled",
  "Blacklisted",
  "NotFound",
  "Reverted",
  "CancelledByUser",
]);

const sleepMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const waitForTaskFinal = async (
  relay: GelatoRelay,
  taskId: string,
  maxAttempts: number,
  intervalMs: number
): Promise<TransactionStatusResponse | undefined> => {
  let lastStatus: TransactionStatusResponse | undefined;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      lastStatus = await relay.getTaskStatus(taskId);
      printTaskStatus(lastStatus, taskId);
      const state = (lastStatus as TransactionStatusResponse & Record<string, unknown>)?.taskState;
      const txHash = (lastStatus as TransactionStatusResponse & Record<string, unknown>)?.transactionHash;
      if (txHash || (state && TERMINAL_STATES.has(String(state)))) {
        return lastStatus;
      }
    } catch (err) {
      console.error(`Failed to fetch task status (attempt ${i + 1}/${maxAttempts})`, err);
    }
    await sleepMs(intervalMs);
  }
  return lastStatus;
};
