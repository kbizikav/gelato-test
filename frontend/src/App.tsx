import { useMemo, useState } from "react";
import { GelatoRelay, type CallWithSyncFeeRequest, type TransactionStatusResponse } from "@gelatonetwork/relay-sdk";
import {
  Address,
  Hex,
  createPublicClient,
  createWalletClient,
  custom,
  encodeFunctionData,
  formatUnits,
  http,
  parseUnits,
  type PublicClient,
  type WalletClient,
} from "viem";
import { base } from "viem/chains";
import { ERC20_PERMIT_ABI, PERMIT_SWAP_ABI } from "./abi";
import { appConfig, NATIVE_TOKEN } from "./config";
import { buildPermitSignature, readPermitMetadata } from "./permit";

type WalletState = {
  address: Address;
  walletClient: WalletClient;
  publicClient: PublicClient;
  chainId: number;
};

type TaskInfo = {
  id: string;
  status?: string;
  txHash?: string;
};

const explorerByChain: Record<number, string> = {
  8453: "https://basescan.org",
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const App = () => {
  const [wallet, setWallet] = useState<WalletState | null>(null);
  const [tokenDecimals, setTokenDecimals] = useState<number | null>(null);
  const [tokenBalance, setTokenBalance] = useState<bigint | null>(null);
  const [amountInput, setAmountInput] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [task, setTask] = useState<TaskInfo | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const balanceText = useMemo(() => {
    if (tokenBalance === null || tokenDecimals === null) return "0.00";
    return formatUnits(tokenBalance, tokenDecimals);
  }, [tokenBalance, tokenDecimals]);

  const addLog = (message: string) => setLogs((prev) => [...prev, message]);

  const fetchTokenState = async (client: PublicClient, owner: Address) => {
    const [meta, balance] = await Promise.all([
      readPermitMetadata(client, appConfig.token, owner),
      client.readContract({
        address: appConfig.token,
        abi: ERC20_PERMIT_ABI,
        functionName: "balanceOf",
        args: [owner],
      }),
    ]);
    setTokenDecimals(meta.decimals);
    setTokenBalance(balance);
    return meta;
  };

  const connectWallet = async () => {
    setError(null);
    setTask(null);
    if (!(window as Window & { ethereum?: unknown }).ethereum) {
      setError("MetaMask (or another EIP-1193 wallet) is not available.");
      return;
    }

    const provider = (window as Window & { ethereum?: any }).ethereum;

    const hexChainId = (await provider.request({ method: "eth_chainId" })) as string;
    let connectedChain = Number(hexChainId);
    if (!Number.isFinite(connectedChain)) {
      setError("Could not read chain id from wallet.");
      return;
    }

    if (connectedChain !== appConfig.chainId) {
      try {
        await provider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: `0x${appConfig.chainId.toString(16)}` }],
        });
        connectedChain = appConfig.chainId;
      } catch (err) {
        setError(`Switch wallet network to chain id ${appConfig.chainId} (Base mainnet).`);
        return;
      }
    }

    const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
    const address = accounts?.[0] as Address | undefined;
    if (!address) {
      setError("No account returned by wallet.");
      return;
    }

    const readTransport = appConfig.rpcUrl ? http(appConfig.rpcUrl) : custom(provider);
    const publicClient = createPublicClient({ chain: base, transport: readTransport });
    const walletClient = createWalletClient({
      account: address,
      chain: base,
      transport: custom(provider),
    });

    await fetchTokenState(publicClient, address);
    setWallet({ address, walletClient, publicClient, chainId: connectedChain });
    addLog(`Connected ${address} on chain ${connectedChain}.`);
  };

  const pollTask = async (relay: GelatoRelay, taskId: string) => {
    for (let i = 0; i < appConfig.statusPolls; i++) {
      try {
        const status = (await relay.getTaskStatus(taskId)) as TransactionStatusResponse & Record<string, unknown>;
        const taskState = status?.taskState ? String(status.taskState) : undefined;
        const txHash = status?.transactionHash ? String(status.transactionHash) : undefined;
        setTask({ id: taskId, status: taskState, txHash });
        addLog(`Status ${i + 1}/${appConfig.statusPolls}: ${taskState ?? "pending"}`);
        if (txHash || (taskState && taskState.toLowerCase().includes("success"))) {
          return;
        }
      } catch (err) {
        addLog(`Status poll failed: ${(err as Error).message ?? err}`);
      }
      await sleep(appConfig.statusIntervalMs);
    }
  };

  const handleSubmit = async (evt?: React.FormEvent<HTMLFormElement>) => {
    evt?.preventDefault();
    setError(null);
    if (!wallet) {
      setError("Connect your wallet first.");
      return;
    }
    if (!appConfig.relayApiKey) {
      setError("Set VITE_GELATO_RELAY_API_KEY in frontend/.env before submitting.");
      return;
    }
    if (tokenDecimals === null || tokenBalance === null) {
      setError("Token balance is not loaded yet.");
      return;
    }
    let parsedAmount: bigint;
    try {
      parsedAmount = parseUnits(amountInput, tokenDecimals);
    } catch {
      setError("Invalid amount format.");
      return;
    }
    if (parsedAmount <= 0n) {
      setError("Amount must be greater than zero.");
      return;
    }
    if (parsedAmount > tokenBalance) {
      setError("Insufficient balance.");
      return;
    }

    setIsSubmitting(true);
    setLogs([]);
    setTask(null);
    const now = Math.floor(Date.now() / 1000);
    const permitDeadline = BigInt(now + appConfig.permitDeadlineSeconds);
    const swapDeadline = BigInt(now + appConfig.swapDeadlineSeconds);
    const relay = new GelatoRelay();

    try {
      addLog("Building permit signature…");
      const permitSig = await buildPermitSignature({
        walletClient: wallet.walletClient,
        publicClient: wallet.publicClient,
        owner: wallet.address,
        token: appConfig.token,
        spender: appConfig.target,
        amount: parsedAmount,
        permitDeadline,
        chainId: appConfig.chainId,
      });

      addLog("Estimating relay fee in native ETH…");
      const estimatedFee = await relay.getEstimatedFee(
        appConfig.chainId,
        NATIVE_TOKEN,
        appConfig.gasLimit,
        appConfig.highPriority
      );
      const maxFeeEth = (estimatedFee * (10_000n + appConfig.feeBufferBps)) / 10_000n;

      const data = encodeFunctionData({
        abi: PERMIT_SWAP_ABI,
        functionName: "permitSwapAndPayFeeNative",
        args: [
          {
            owner: wallet.address,
            value: permitSig.amount,
            deadline: permitDeadline,
            v: permitSig.v,
            r: permitSig.r as Hex,
            s: permitSig.s as Hex,
          },
          { minEthOut: appConfig.swapMinEthOut, deadline: swapDeadline },
          maxFeeEth,
        ],
      });

      const request: CallWithSyncFeeRequest = {
        chainId: appConfig.chainId,
        target: appConfig.target,
        data,
        feeToken: NATIVE_TOKEN,
        isRelayContext: true,
      };

      addLog("Submitting to Gelato Relay…");
      const { taskId } = await relay.callWithSyncFee(request, { gasLimit: appConfig.gasLimit }, appConfig.relayApiKey);
      addLog(`Task submitted: ${taskId}`);
      setTask({ id: taskId, status: "Submitted" });
      await pollTask(relay, taskId);
      await fetchTokenState(wallet.publicClient, wallet.address);
    } catch (err) {
      console.error(err);
      setError((err as Error).message ?? String(err));
      addLog(`Error: ${(err as Error).message ?? err}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const explorerHref = useMemo(() => {
    if (!task?.txHash || !wallet?.chainId) return undefined;
    const baseUrl = explorerByChain[wallet.chainId];
    return baseUrl ? `${baseUrl}/tx/${task.txHash}` : undefined;
  }, [task?.txHash, wallet?.chainId]);

  return (
    <div className="shell">
      <header className="header">
        <div className="header-content">
          <h1 className="title">Gelato Gasless Swap</h1>
          <p className="subtitle">Swap tokens without paying ETH for gas</p>
        </div>
        <button className="connect-btn" onClick={connectWallet}>
          {wallet ? (
            <>
              <span className="status-dot"></span>
              {wallet.address.slice(0, 6)}...{wallet.address.slice(-4)}
            </>
          ) : (
            "Connect Wallet"
          )}
        </button>
      </header>

      <main className="main-content">
        <div className="card swap-card">
          {!appConfig.relayApiKey && (
            <div className="banner error">
              Configuration Error: Relay API Key is missing.
            </div>
          )}

          <form onSubmit={handleSubmit} className="swap-form">
            <div className="input-group">
              <div className="input-header">
                <label htmlFor="amount">Pay</label>
                <span className="balance">
                  Balance: <span className="balance-value">{balanceText}</span>
                </span>
              </div>
              <div className="input-wrapper">
                <input
                  id="amount"
                  placeholder="0.0"
                  value={amountInput}
                  onChange={(e) => setAmountInput(e.target.value)}
                  inputMode="decimal"
                  autoComplete="off"
                  className="amount-input"
                />
              </div>
            </div>

            {error && <div className="error-message">{error}</div>}

            <button 
              className="cta-button" 
              type="submit" 
              disabled={isSubmitting || !wallet}
            >
              {isSubmitting ? "Processing..." : "Swap"}
            </button>
          </form>

          {task && (
            <div className="task-status-container">
               <div className="task-row">
                 <span className="label">Status</span>
                 <span className="value">{task.status ?? "Pending"}</span>
               </div>
               {task.txHash && (
                 <div className="task-row">
                    <span className="label">Transaction</span>
                    {explorerHref ? (
                      <a href={explorerHref} target="_blank" rel="noreferrer" className="explorer-link">
                        View on Explorer ↗
                      </a>
                    ) : (
                      <span className="value truncated">{task.txHash}</span>
                    )}
                 </div>
               )}
            </div>
          )}
        </div>
        
        {logs.length > 0 && (
            <details className="logs-details">
                <summary>Debug Logs</summary>
                <div className="logs-container">
                    {logs.map((line, idx) => (
                        <div key={idx} className="log-line">{line}</div>
                    ))}
                </div>
            </details>
        )}
      </main>
    </div>
  );
};

export default App;