// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

/* 
    Token Sale contract with:
    - 20% immediate distribution
    - 80% vesting with a 3-month cliff + linear monthly vesting
*/

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract TokenSaleWithVesting is Ownable(msg.sender), ReentrancyGuard {
    using SafeERC20 for IERC20;

    // --------------------------------------------------------
    // State Variables
    // --------------------------------------------------------

    /// @dev The token being sold.
    IERC20 public tokenA;

    /// @dev The payment token (USDT).
    IERC20 public usdt;

    /// @dev Price of 1 TokenA in terms of USDT (e.g., if USDT has 6 decimals,
    ///      and you want 1 TokenA = 2 USDT, price = 2e6).
    uint256 public tokenPriceInUSDT;

    /// @dev Minimum USDT that a buyer must spend in a single purchase.
    uint256 public minPurchaseAmountInUSDT;

    /// @dev Cliff period (3 months, default ~ 90 days).
    uint256 public cliffPeriod = 90 days;

    /// @dev Vesting duration after cliff (e.g., 9 months -> 270 days).
    uint256 public vestingDuration = 270 days;

    /// @dev Indicates if the sale is paused.
    bool public paused = false;

    /// @dev Each purchase creates a vesting schedule for the buyer.
    struct VestingSchedule {
        uint256 totalPurchased; // Total TokenA purchased (80% goes to vesting portion)
        uint256 totalClaimed; // How many tokens have been claimed (including the 20% immediate portion)
        uint256 startTimestamp; // Timestamp when the purchase was made (used for cliff + vesting)
    }

    /// @dev Mapping from user address to its vesting schedule.
    mapping(address => VestingSchedule) public vestingSchedules;

    // --------------------------------------------------------
    // Events
    // --------------------------------------------------------

    event TokenPriceUpdated(uint256 oldPrice, uint256 newPrice);
    event MinPurchaseUpdated(uint256 oldMinPurchase, uint256 newMinPurchase);
    event DepositTokenA(address indexed depositor, uint256 amount);
    event Purchase(
        address indexed buyer,
        uint256 usdtSpent,
        uint256 tokenAmount,
        uint256 immediateRelease
    );
    event Claim(address indexed buyer, uint256 claimedAmount);
    event WithdrawToken(
        address indexed token,
        address indexed to,
        uint256 amount
    );
    event Paused(address indexed account);
    event Unpaused(address indexed account);

    // --------------------------------------------------------
    // Constructor
    // --------------------------------------------------------

    constructor(
        address _tokenA,
        address _usdt,
        uint256 _tokenPriceInUSDT,
        uint256 _minPurchaseAmountInUSDT
    ) {
        require(_tokenA != address(0), "TokenA address zero");
        require(_usdt != address(0), "USDT address zero");
        require(_tokenPriceInUSDT > 0, "Price must be > 0");

        tokenA = IERC20(_tokenA);
        usdt = IERC20(_usdt);

        tokenPriceInUSDT = _tokenPriceInUSDT;
        minPurchaseAmountInUSDT = _minPurchaseAmountInUSDT;
    }

    // --------------------------------------------------------
    // Modifiers
    // --------------------------------------------------------

    /**
     * @dev Ensures the sale is not paused.
     */
    modifier whenNotPaused() {
        require(!paused, "Sale is paused");
        _;
    }

    // --------------------------------------------------------
    // Admin Functions
    // --------------------------------------------------------

    /**
     * @notice Admin can update the token sale price in USDT.
     * @param _newPrice The new price for 1 TokenA in USDT units.
     */
    function setTokenPrice(uint256 _newPrice) external onlyOwner {
        require(_newPrice > 0, "Price must be > 0");
        uint256 oldPrice = tokenPriceInUSDT;
        tokenPriceInUSDT = _newPrice;
        emit TokenPriceUpdated(oldPrice, _newPrice);
    }

    /**
     * @notice Admin can update the minimum purchase amount in USDT.
     * @param _newMinPurchase New minimum USDT purchase amount.
     */
    function setMinPurchaseAmount(uint256 _newMinPurchase) external onlyOwner {
        uint256 oldMinPurchase = minPurchaseAmountInUSDT;
        minPurchaseAmountInUSDT = _newMinPurchase;
        emit MinPurchaseUpdated(oldMinPurchase, _newMinPurchase);
    }

    /**
     * @notice Admin can deposit TokenA into this contract for sale.
     * @param amount The amount of TokenA to deposit.
     */
    function depositTokenA(uint256 amount) external onlyOwner {
        require(amount > 0, "Cannot deposit zero");
        tokenA.safeTransferFrom(msg.sender, address(this), amount);
        emit DepositTokenA(msg.sender, amount);
    }

    /**
     * @notice Admin can pause the sale (no purchases possible).
     */
    function pause() external onlyOwner {
        require(!paused, "Already paused");
        paused = true;
        emit Paused(msg.sender);
    }

    /**
     * @notice Admin can unpause the sale.
     */
    function unpause() external onlyOwner {
        require(paused, "Already unpaused");
        paused = false;
        emit Unpaused(msg.sender);
    }

    /**
     * @notice Admin can withdraw any token (TokenA or USDT).
     *         - If withdrawing TokenA: it might be unsold tokens.
     *         - If withdrawing USDT: it is the raised funds.
     * @param _token Address of the token to withdraw (TokenA or USDT).
     * @param _to Recipient address.
     * @param _amount Amount to withdraw.
     */
    function adminWithdraw(
        address _token,
        address _to,
        uint256 _amount
    ) external onlyOwner {
        require(_to != address(0), "Invalid address");
        require(_amount > 0, "Amount must be > 0");

        IERC20(_token).safeTransfer(_to, _amount);
        emit WithdrawToken(_token, _to, _amount);
    }

    // --------------------------------------------------------
    // Public User Functions
    // --------------------------------------------------------

    /**
     * @notice Buy TokenA with USDT.
     *         User must approve this contract to spend `usdtAmount` before calling.
     * @param usdtAmount The amount of USDT user wants to spend.
     */
    function buyTokenA(uint256 usdtAmount) external whenNotPaused nonReentrant {
        require(usdtAmount >= minPurchaseAmountInUSDT, "Below min purchase");
        require(usdtAmount > 0, "No USDT sent");

        // 1) Transfer USDT from buyer to contract.
        usdt.safeTransferFrom(msg.sender, address(this), usdtAmount);

        // 2) Calculate how many TokenA user receives in total.
        //    If tokenPriceInUSDT = price of 1 TokenA in USDT (6 decimals),
        //    watch for decimal mismatches. This example assumes:
        //       - USDT has 6 decimals
        //       - TokenA has 18 decimals
        //
        //    So if user sends 1e6 USDT (which is 1 USDT),
        //    and tokenPriceInUSDT = 2e6 (2 USDT per TokenA),
        //    then the user gets (1e6 * 10^18 / 2e6) = 0.5 * 1e18 = 0.5 TokenA.
        //
        //    Adjust for your own tokens' decimals if different.
        uint256 tokenAmount = (usdtAmount * (10 ** 18)) / tokenPriceInUSDT;

        require(tokenAmount > 0, "Computed tokenAmount is 0");

        // 3) Update vesting schedule for the buyer.
        VestingSchedule storage schedule = vestingSchedules[msg.sender];
        if (schedule.totalPurchased == 0) {
            // If first purchase
            schedule.startTimestamp = block.timestamp;
        }
        schedule.totalPurchased += tokenAmount;

        // 4) Immediately release 20% to the buyer.
        uint256 immediateRelease = (tokenAmount * 20) / 100;
        // Transfer that immediately.
        tokenA.safeTransfer(msg.sender, immediateRelease);

        // 5) Record that those tokens have been claimed already
        schedule.totalClaimed += immediateRelease;

        emit Purchase(msg.sender, usdtAmount, tokenAmount, immediateRelease);
    }

    /**
     * @notice Claim any vested tokens that have become claimable.
     */
    function claimVestedTokens() external nonReentrant {
        VestingSchedule storage schedule = vestingSchedules[msg.sender];
        require(schedule.totalPurchased > 0, "No purchased tokens");

        uint256 vested = _vestedAmount(msg.sender, block.timestamp);
        uint256 alreadyClaimed = schedule.totalClaimed;

        require(vested > alreadyClaimed, "Nothing to claim now");

        uint256 claimable = vested - alreadyClaimed;
        schedule.totalClaimed += claimable;

        tokenA.safeTransfer(msg.sender, claimable);

        emit Claim(msg.sender, claimable);
    }

    // --------------------------------------------------------
    // View Functions
    // --------------------------------------------------------

    /**
     * @notice Returns how many tokens have vested for a user at the current time.
     *         (This includes the 20% immediate release.)
     * @param user The user address.
     */
    function vestedAmount(address user) external view returns (uint256) {
        return _vestedAmount(user, block.timestamp);
    }

    /**
     * @notice Returns how many tokens are currently claimable by a user.
     */
    function claimableAmount(address user) external view returns (uint256) {
        VestingSchedule storage schedule = vestingSchedules[user];
        uint256 vested = _vestedAmount(user, block.timestamp);
        return vested - schedule.totalClaimed;
    }

    // --------------------------------------------------------
    // Internal Functions
    // --------------------------------------------------------

    /**
     * @dev Calculates how many tokens a user has vested in total (incl. the 20% immediate).
     *      Vesting logic:
     *       - 20% immediately,
     *       - 80% after 3-month cliff, linearly over `vestingDuration`.
     */
    function _vestedAmount(
        address user,
        uint256 currentTime
    ) internal view returns (uint256) {
        VestingSchedule memory schedule = vestingSchedules[user];
        uint256 totalPurchased = schedule.totalPurchased;
        if (totalPurchased == 0) return 0;

        // Immediately 20% is fully vested at purchase time.
        uint256 immediateRelease = (totalPurchased * 20) / 100;
        uint256 vestingPortion = totalPurchased - immediateRelease;

        // Check if we are before the cliff:
        uint256 cliffEnd = schedule.startTimestamp + cliffPeriod;
        if (currentTime < cliffEnd) {
            // Before cliff => only 20% immediate is vested
            return immediateRelease;
        }

        // After cliff, linear vesting over `vestingDuration` seconds
        uint256 timeAfterCliff = currentTime - cliffEnd;
        if (timeAfterCliff >= vestingDuration) {
            // All tokens are vested
            return totalPurchased;
        } else {
            // Fraction of vestingPortion = (timeAfterCliff / vestingDuration)
            uint256 vestedFromPortion = (vestingPortion * timeAfterCliff) /
                vestingDuration;
            return immediateRelease + vestedFromPortion;
        }
    }
}
