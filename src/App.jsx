import { useState, useEffect } from "react";
import {
  ChakraProvider,
  Box,
  VStack,
  Heading,
  Text,
  Button,
  useToast,
  Input,
  FormControl,
  FormLabel,
  FormHelperText,
  Spinner,
  SimpleGrid,
} from "@chakra-ui/react";
import { ethers } from "ethers";
import { tokensaleABI } from "./assets/constants";
import logo from "./assets/logo.png";

/**
 * Change these to match your actual deployed contract and tokens.
 * - If your contract expects 18-decimal USDT amounts,
 *   then the pegged USDT on BSC (0x55d398...) is indeed 18 decimals, so this is consistent.
 */
const CONTRACT_ADDRESS = "0x28e85E2C11478AB9bDB36F845f97a8af6D152019";
const CONTRACT_ABI = tokensaleABI;

const USDT_ADDRESS = "0x55d398326f99059fF775485246999027B3197955";
/**
 * Minimal ABI for USDT to approve/spend/balance
 * The real pegged USDT on BSC is 18 decimals, so parseUnits/formatUnits must use 18.
 */
const USDT_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
];

// BSC Mainnet configuration
const BSC_CHAIN_ID = "0x38";
const BSC_RPC_URL = "https://bsc-dataseed1.binance.org";
const BSC_NETWORK = {
  chainId: BSC_CHAIN_ID,
  chainName: "Binance Smart Chain",
  nativeCurrency: {
    name: "BNB",
    symbol: "BNB",
    decimals: 18,
  },
  rpcUrls: [BSC_RPC_URL],
  blockExplorerUrls: ["https://bscscan.com"],
};

function App() {
  const [provider, setProvider] = useState(null);
  const [signer, setSigner] = useState(null);
  const [address, setAddress] = useState("");
  const [contract, setContract] = useState(null);
  const [usdtContract, setUsdtContract] = useState(null);

  // Contract data
  const [tokenPrice, setTokenPrice] = useState("0"); // formatted in "USDT" units
  const [minPurchase, setMinPurchase] = useState("0"); // formatted in "USDT" units
  const [vestingSchedule, setVestingSchedule] = useState(null);
  const [claimableAmount, setClaimableAmount] = useState("0");

  // User state
  const [usdtBalance, setUsdtBalance] = useState("0"); // in USDT
  const [usdtAllowance, setUsdtAllowance] = useState("0"); // in USDT
  const [investAmount, setInvestAmount] = useState(""); // raw input
  const [isAdmin, setIsAdmin] = useState(false);

  const [isLoading, setIsLoading] = useState(false);
  const toast = useToast();

  // ------------------------------------------------------------------
  // 1. Connect Wallet & Setup
  // ------------------------------------------------------------------
  const connectWallet = async () => {
    if (!window.ethereum) {
      toast({
        title: "Error",
        description: "Please install MetaMask to use this app.",
        status: "error",
        duration: 5000,
      });
      return;
    }

    try {
      // Request account access
      await window.ethereum.request({ method: "eth_requestAccounts" });

      // Switch to BSC network
      try {
        await window.ethereum.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: BSC_CHAIN_ID }],
        });
      } catch (switchError) {
        // If BSC network is not added, add it
        if (switchError.code === 4902) {
          try {
            await window.ethereum.request({
              method: "wallet_addEthereumChain",
              params: [BSC_NETWORK],
            });
          } catch (addError) {
            throw new Error("Failed to add BSC network");
          }
        } else {
          throw new Error("Failed to switch to BSC network");
        }
      }

      const _provider = new ethers.providers.Web3Provider(window.ethereum);
      const _signer = _provider.getSigner();
      const _address = await _signer.getAddress();

      // Instantiate contracts
      const _contract = new ethers.Contract(
        CONTRACT_ADDRESS,
        CONTRACT_ABI,
        _signer
      );
      const _usdtContract = new ethers.Contract(
        USDT_ADDRESS,
        USDT_ABI,
        _signer
      );

      setProvider(_provider);
      setSigner(_signer);
      setAddress(_address);
      setContract(_contract);
      setUsdtContract(_usdtContract);

      // Check if connected address is admin (contract owner)
      const owner = await _contract.owner();
      setIsAdmin(owner.toLowerCase() === _address.toLowerCase());

      // Load initial contract data
      await loadContractData(_contract, _usdtContract, _address);

      toast({
        title: "Success",
        description: "Wallet connected successfully",
        status: "success",
        duration: 3000,
      });
    } catch (error) {
      console.error("Error connecting wallet:", error);
      toast({
        title: "Error",
        description: error.message || "Failed to connect wallet",
        status: "error",
        duration: 5000,
      });
    }
  };

  // ------------------------------------------------------------------
  // 2. Load contract/user data
  // ------------------------------------------------------------------
  const loadContractData = async (saleContract, tetherContract, userAddr) => {
    if (!saleContract || !tetherContract) return;

    try {
      // 2.1 Fetch on-chain data
      const price = await saleContract.tokenPriceInUSDT();
      const minAmount = await saleContract.minPurchaseAmountInUSDT();
      const schedule = await saleContract.vestingSchedules(userAddr);
      const claimable = await saleContract.claimableAmount(userAddr);

      // 2.2 Fetch user USDT info
      const balance = await tetherContract.balanceOf(userAddr);
      const allowance = await tetherContract.allowance(
        userAddr,
        CONTRACT_ADDRESS
      );

      /**
       * Because we are assuming USDT is 18 decimals on BSC:
       * - tokenPriceInUSDT is also stored in 18 decimals for the “price”.
       * - minPurchaseAmountInUSDT is in 18 decimals.
       * - USDT balance and allowance are in 18 decimals.
       */
      setTokenPrice(ethers.utils.formatUnits(price, 18)); // e.g. "2.0" means 2 USDT
      setMinPurchase(ethers.utils.formatUnits(minAmount, 18));

      // For TokenA vesting schedule, TokenA presumably has 18 decimals as well:
      setVestingSchedule({
        totalPurchased: ethers.utils.formatUnits(schedule.totalPurchased, 18),
        totalClaimed: ethers.utils.formatUnits(schedule.totalClaimed, 18),
        startTimestamp: schedule.startTimestamp.toString(),
      });

      // claimableAmount in TokenA (18 decimals)
      setClaimableAmount(ethers.utils.formatUnits(claimable, 18));

      // USDT balance & allowance
      setUsdtBalance(ethers.utils.formatUnits(balance, 18));
      setUsdtAllowance(ethers.utils.formatUnits(allowance, 18));
    } catch (error) {
      console.error("Error loading contract data:", error);
      toast({
        title: "Error",
        description: "Failed to load contract data",
        status: "error",
        duration: 5000,
      });
    }
  };

  // ------------------------------------------------------------------
  // 3. Buy tokens
  // ------------------------------------------------------------------
  const handleInvestmentSubmit = async (e) => {
    e.preventDefault();
    if (!contract || !usdtContract || !investAmount) return;

    try {
      setIsLoading(true);

      /**
       * Because BSC-pegged USDT has 18 decimals, parse the user input with 18 decimals.
       * E.g. if user typed "1.0", parseUnits("1.0", 18) => 1e18.
       */
      const usdtAmount = ethers.utils.parseUnits(investAmount, 18);

      // 3.1 Check if current allowance is sufficient
      const currentAllowance = await usdtContract.allowance(
        address,
        CONTRACT_ADDRESS
      );
      if (currentAllowance.lt(usdtAmount)) {
        const approveTx = await usdtContract.approve(
          CONTRACT_ADDRESS,
          usdtAmount
        );
        await approveTx.wait();
        toast({
          title: "Approval Success",
          description: `Approved ${investAmount} USDT for spending`,
          status: "success",
          duration: 3000,
        });
      }

      // 3.2 Call buy function
      const buyTx = await contract.buyTokenA(usdtAmount);
      await buyTx.wait();

      toast({
        title: "Success",
        description: "Successfully purchased tokens",
        status: "success",
        duration: 5000,
      });

      setInvestAmount("");
      await loadContractData(contract, usdtContract, address);
    } catch (error) {
      console.error("Error buying tokens:", error);
      toast({
        title: "Error",
        description: error.message || "Failed to buy tokens",
        status: "error",
        duration: 5000,
      });
    } finally {
      setIsLoading(false);
    }
  };

  // ------------------------------------------------------------------
  // 4. Claim vested tokens
  // ------------------------------------------------------------------
  const claimTokens = async () => {
    if (!contract) return;

    try {
      setIsLoading(true);
      const tx = await contract.claimVestedTokens();
      await tx.wait();

      toast({
        title: "Success",
        description: "Successfully claimed tokens",
        status: "success",
        duration: 5000,
      });

      await loadContractData(contract, usdtContract, address);
    } catch (error) {
      console.error("Error claiming tokens:", error);
      toast({
        title: "Error",
        description: error.message || "Failed to claim tokens",
        status: "error",
        duration: 5000,
      });
    } finally {
      setIsLoading(false);
    }
  };

  // ------------------------------------------------------------------
  // 5. Handle account/network changes
  // ------------------------------------------------------------------
  useEffect(() => {
    if (window.ethereum) {
      // Reload on account change
      window.ethereum.on("accountsChanged", () => {
        window.location.reload();
      });
      // Reload on chain change
      window.ethereum.on("chainChanged", () => {
        window.location.reload();
      });
    }
  }, []);

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------
  return (
    <ChakraProvider>
      <Box
        minH="100vh"
        w="100vw"
        bg="gray.900"
        bgGradient="linear(to-b, gray.900, gray.800)"
        color="whiteAlpha.900"
        p={0}>
        <VStack spacing={8} align="stretch" maxW="1200px" mx="auto" p={8}>
          <Heading
            size="2xl"
            bgGradient="linear(to-r, cyan.400, blue.500)"
            bgClip="text"
            textAlign="center">
            Navis Ecosystem
          </Heading>

          {!address ? (
            <Button colorScheme="blue" onClick={connectWallet}>
              Connect Wallet
            </Button>
          ) : (
            <VStack spacing={4} align="stretch">
              <Box display="flex" justifyContent="center" mb={6}>
                <img
                  src={logo}
                  alt="Navis Logo"
                  style={{ maxWidth: "200px" }}
                />
              </Box>
              <Text textAlign="center">Connected: {address}</Text>
              <Text textAlign="center">Token Price: {tokenPrice} USDT</Text>
              <Text textAlign="center">
                Minimum Purchase: {minPurchase} USDT
              </Text>
              <Text textAlign="center">
                Your USDT Balance: {usdtBalance} USDT
              </Text>
              <Text textAlign="center">
                USDT Allowance: {usdtAllowance} USDT
              </Text>

              <Box borderWidth={1} p={4} borderRadius="md">
                <form onSubmit={handleInvestmentSubmit}>
                  <FormControl>
                    <FormLabel>Investment Amount (USDT)</FormLabel>
                    <Input
                      type="number"
                      value={investAmount}
                      onChange={(e) => setInvestAmount(e.target.value)}
                      placeholder="Enter USDT amount"
                      // If using 18 decimals, minPurchase is in 18 decimals
                      min={0}

                      disabled={isLoading}
                    />
                    <FormHelperText>
                      Minimum investment: {minPurchase} USDT
                    </FormHelperText>
                  </FormControl>
                  <Button
                    mt={4}
                    colorScheme="blue"
                    type="submit"
                    isLoading={isLoading}
                    loadingText="Processing"
                    disabled={
                      isLoading ||
                      !investAmount ||
                      Number(investAmount) <= 0 ||
                      Number(investAmount) > Number(usdtBalance)
                    }>
                    Buy Tokens
                  </Button>
                </form>
              </Box>

              {vestingSchedule && (
                <Box borderWidth={1} p={4} borderRadius="md">
                  <Heading size="md">Your Vesting Schedule</Heading>
                  <Text>
                    Total Purchased: {vestingSchedule.totalPurchased} $NAVIX
                  </Text>
                  <Text>
                    Total Claimed: {vestingSchedule.totalClaimed} $NAVIX
                  </Text>
                  <Text>Claimable Now: {claimableAmount} $NAVIX</Text>
                  {Number(claimableAmount) > 0 && (
                    <Button
                      mt={2}
                      colorScheme="green"
                      onClick={claimTokens}
                      isLoading={isLoading}>
                      Claim Tokens
                    </Button>
                  )}
                </Box>
              )}
            </VStack>
          )}
        </VStack>
      </Box>
    </ChakraProvider>
  );
}

export default App;
