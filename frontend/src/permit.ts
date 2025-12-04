import { type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { ERC20_PERMIT_ABI } from "./abi";

export const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export type PermitMeta = {
  name: string;
  version: string;
  decimals: number;
  nonce: bigint;
};

const readTokenVersion = async (client: PublicClient, token: Address): Promise<string> => {
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

export const readPermitMetadata = async (
  client: PublicClient,
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
  walletClient: WalletClient;
  publicClient: PublicClient;
  owner: Address;
  token: Address;
  spender: Address;
  amount: bigint;
  permitDeadline: bigint;
  chainId: number;
}): Promise<PermitSignatureResult> => {
  const { walletClient, publicClient, owner, token, spender, amount, permitDeadline, chainId } = params;
  const meta = await readPermitMetadata(publicClient, token, owner);
  const signature = await walletClient.signTypedData({
    account: owner,
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
