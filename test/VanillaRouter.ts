import { ethers, waffle } from "hardhat"
import { expect } from "chai"
import { Contract, Wallet, BigNumber, constants, Signer } from "ethers"
import {
  createLiquidityETH, createPair,
  deployTokens, deployUniswap, Erc20ish,
  setupUniswap,
  setupUniswapRouter,
  tokenAmount,
  uniswapPrices,
} from "./UniswapSetup"

import VanillaRouter from "../artifacts/contracts/VanillaRouter.sol/VanillaRouter.json"
import VanillaGovernanceToken from "../artifacts/contracts/VanillaGovernanceToken.sol/VanillaGovernanceToken.json"
import VanillaRouterDelegate from "./contracts/VanillaRouterDelegate.json"
import ERC20 from "@uniswap/v2-periphery/build/ERC20.json"
import { assert, asyncProperty, bigUintN, constant, integer, nat, pre, property, tuple } from "fast-check"

const { MaxUint256 } = constants
const { provider, deployContract, createFixtureLoader } = waffle

type VanillaContractSetup = {
  router: Contract;
  trader2: Wallet;
  VNL: Contract;
  tokenA: Contract;
  tokenB: Contract;
  trader: Wallet;
  liqAW: Erc20ish;
  WETH: Contract;
  testRouter: Contract;
  liqBW: Erc20ish;
  liqB: Erc20ish;
  liqA: Erc20ish;
  uniswapRouter: Contract
}
type Fixture<T> = (wallets: Wallet[], provider: any) => Promise<T>

const loader = createFixtureLoader(provider.getWallets(), provider)
const loadFixture = async (fixture: Fixture<VanillaContractSetup>) => {
  let snapshot: VanillaContractSetup = await loader(fixture)
  return {
    ...snapshot,
    pairA: uniswapPrices(snapshot.liqAW, snapshot.liqA),
    pairB: uniswapPrices(snapshot.liqBW, snapshot.liqB),
  }
}
const LIMIT_NOT_USED = 1

describe("UniswapRouter", async () => {
  async function fixture ([vanillaOwner, ourUniswap, tokenDeployer, trader, trader2]: Wallet[]): Promise<VanillaContractSetup> {
    let { tokenA, tokenB, WETH } = await deployTokens(tokenDeployer)

    let { factory, router: uniswapRouter } = await deployUniswap(ourUniswap, WETH)
    await createPair(ourUniswap, factory, WETH, tokenA)
    let { tokenLiquidity: liqA, wethLiquidity: liqAW } = await createLiquidityETH(tokenA.signer, uniswapRouter, tokenA, WETH)

    await createPair(ourUniswap, factory, WETH, tokenB)
    let { tokenLiquidity: liqB, wethLiquidity: liqBW } = await createLiquidityETH(tokenB.signer, uniswapRouter, tokenB, WETH)

    let router = await deployContract(vanillaOwner, VanillaRouter, [uniswapRouter.address, tokenAmount(100), [tokenA.address]])
    let VNL = new Contract(await router.vnlContract(), VanillaGovernanceToken.abi, provider)
    let testRouter = await deployContract(vanillaOwner, VanillaRouterDelegate, [uniswapRouter.address, [tokenA.address]])
    // await logGasUsage("Router-deploy", router.deployTransaction)
    return { router, tokenA, tokenB, trader, trader2, WETH, testRouter, liqA, liqAW, liqB, liqBW, VNL, uniswapRouter }
  }

  it("Gas cost checks", async () => {
    let { router, trader, tokenA, WETH } = await loadFixture(fixture)

    const gasUsage = async (call: any) => {
      let tx = await call
      return (await tx.wait()).gasUsed
    }
    expect(await gasUsage(router.deployTransaction)).to.equal(2735722)

    router = router.connect(trader)
    expect(await gasUsage(router.depositAndBuy(tokenA.address, LIMIT_NOT_USED, MaxUint256, { value: tokenAmount(5) })))
      .to.equal(248092)

    expect(await gasUsage(router.sellAndWithdraw(tokenA.address, 1000, LIMIT_NOT_USED, MaxUint256)))
      .to.equal(155610)

    let ethAmount = tokenAmount(5)
    WETH = WETH.connect(trader)
    await WETH.deposit({ value: ethAmount })
    await WETH.approve(router.address, ethAmount)

    expect(await gasUsage(router.buy(tokenA.address, ethAmount, LIMIT_NOT_USED, MaxUint256)))
      .to.equal(113787)

    expect(await gasUsage(router.sell(tokenA.address, 493, LIMIT_NOT_USED, MaxUint256)))
      .to.equal(199367)
  })

  it("Buying and selling with Ether works", async () => {
    let { router, trader, tokenA, pairA } = await loadFixture(fixture)

    let reserveFromUniswapSetup = tokenAmount(500)
    router = router.connect(trader)
    let eth = tokenAmount(5)
    let expectedTokens = pairA.buy(eth)
    let balanceBeforeDeposit = await trader.getBalance()
    expect(expectedTokens).to.equal(tokenAmount("493.5790171985306494"))
    let txrq = router.depositAndBuy(tokenA.address, LIMIT_NOT_USED, MaxUint256, { value: eth })
    await expect(txrq)
      .to.emit(router, "TokensPurchased")
      .withArgs(trader.address, tokenA.address, eth, expectedTokens, reserveFromUniswapSetup)
    let tx = await txrq
    let receipt = await tx.wait()
    let balanceAfterDeposit = await trader.getBalance()
    let txCost = receipt.gasUsed.mul(tx.gasPrice)
    expect(balanceBeforeDeposit.sub(balanceAfterDeposit).sub(txCost)).to.equal(BigNumber.from(eth))
    expect(await tokenA.balanceOf(router.address)).to.equal(expectedTokens)

    let expectedETH = pairA.sell(expectedTokens)
    expect(expectedETH).to.equal(tokenAmount("497.0339824810796450"))
    let balanceBeforeWithdraw = await trader.getBalance()
    txrq = router.sellAndWithdraw(tokenA.address, expectedTokens, LIMIT_NOT_USED, MaxUint256)
    await expect(txrq)
      .to.emit(router, "TokensSold")
      .withArgs(trader.address, tokenA.address, expectedTokens, expectedETH, 0, 0, reserveFromUniswapSetup)
    tx = await txrq
    receipt = await tx.wait()
    let balanceAfterWithdraw = await trader.getBalance()
    txCost = receipt.gasUsed.mul(tx.gasPrice)
    expect(balanceAfterWithdraw.sub(balanceBeforeWithdraw).add(txCost)).to.equal(BigNumber.from(expectedETH))
    expect(await tokenA.balanceOf(router.address)).to.equal(0)
  })

  it("Buying and selling with WETH works", async () => {
    let { router, trader, tokenA, WETH, pairA } = await loadFixture(fixture)

    let ethAmount = tokenAmount(5)
    let reserveFromUniswapSetup = tokenAmount(500)
    router = router.connect(trader)

    WETH = WETH.connect(trader)

    await WETH.deposit({ value: ethAmount })
    await WETH.approve(router.address, ethAmount)
    expect(await WETH.balanceOf(trader.address)).to.equal(ethAmount)

    let expectedTokens = pairA.buy(ethAmount)
    expect(expectedTokens).to.equal(tokenAmount("493.5790171985306494"))
    await expect(router.buy(tokenA.address, ethAmount, LIMIT_NOT_USED, MaxUint256))
      .to.emit(router, "TokensPurchased")
      .withArgs(trader.address, tokenA.address, ethAmount, expectedTokens, reserveFromUniswapSetup)
    expect(await WETH.balanceOf(trader.address)).to.equal(0)
    expect(await tokenA.balanceOf(router.address)).to.equal(expectedTokens)

    let expectedWETH = pairA.sell(expectedTokens)
    expect(expectedWETH).to.equal(tokenAmount("497.0339824810796450"))
    await expect(router.sell(tokenA.address, expectedTokens, LIMIT_NOT_USED, MaxUint256))
      .to.emit(router, "TokensSold")
      .withArgs(trader.address, tokenA.address, expectedTokens, expectedWETH, 0, 0, reserveFromUniswapSetup)
    expect(await tokenA.balanceOf(router.address)).to.equal(0)
    expect(await WETH.balanceOf(trader.address)).to.equal(expectedWETH)
  })

  describe("Failure modes", async () => {
    it("Buy without approve fails", async () => {
      const { router, trader, tokenA } = await loadFixture(fixture)
      await expect(router.connect(trader).buy(tokenA.address, tokenAmount(5), LIMIT_NOT_USED, MaxUint256)).to.be.reverted
    })

    it("Buy without sufficient approve fails", async () => {
      let { router, trader, tokenA, WETH } = await loadFixture(fixture)

      let depositAmount = tokenAmount(4)
      let purchaseAmount = tokenAmount(5)

      WETH = WETH.connect(trader)
      await WETH.deposit({ value: depositAmount })
      await WETH.approve(router.address, depositAmount)
      await expect(router.connect(trader).buy(tokenA.address, purchaseAmount, LIMIT_NOT_USED, MaxUint256)).to.be.reverted
    })

    it("Buying with too high limit reverts", async () => {
      let { router, trader, tokenA, WETH, pairA } = await loadFixture(fixture)

      let ethAmount = tokenAmount(5)

      WETH = WETH.connect(trader)
      await WETH.deposit({ value: ethAmount })
      await WETH.approve(router.address, ethAmount)
      let expectedTokens = pairA.buy(ethAmount)
      await expect(router.connect(trader).buy(tokenA.address, ethAmount, expectedTokens.add(1000), MaxUint256)).to.be.revertedWith("a1")
    })

    it("Selling without buying fails", async () => {
      const { router, trader, tokenA, WETH } = await loadFixture(fixture)

      await expect(router.connect(trader).sell(tokenA.address, 1000, LIMIT_NOT_USED, MaxUint256)).to.be.revertedWith("TransferHelper: TRANSFER_FAILED")
    })

    it("Selling with too high limit reverts", async () => {
      let { router, trader, tokenA, WETH, pairA } = await loadFixture(fixture)

      let ethAmount = tokenAmount(5)

      WETH = WETH.connect(trader)
      router = router.connect(trader)
      // Verify that trader's WETH balance is not ignored in limit checking (PVE-001)
      await WETH.deposit({ value: ethAmount.add(tokenAmount(1000)) })
      await WETH.approve(router.address, ethAmount)
      let expectedTokens = pairA.buy(ethAmount)
      await router.buy(tokenA.address, ethAmount, expectedTokens, MaxUint256)

      let expectedWETH = pairA.sell(expectedTokens)
      let limitTooHigh = expectedWETH.add(tokenAmount(1))
      await expect(router.sell(tokenA.address, expectedTokens, limitTooHigh, MaxUint256)).to.be.revertedWith("a1")
    })

    it("Selling more than owned fails", async () => {
      let { router, trader, tokenA, trader2, pairA } = await loadFixture(fixture)

      router = router.connect(trader)

      let ethSpent = tokenAmount(5)
      let totalTokensOfTrader1 = pairA.buy(ethSpent)
      await router.depositAndBuy(tokenA.address, LIMIT_NOT_USED, MaxUint256, { value: ethSpent })
      expect(await tokenA.balanceOf(router.address)).to.equal(totalTokensOfTrader1)

      let ethSpent2 = tokenAmount(10)
      await router.connect(trader2).depositAndBuy(tokenA.address, LIMIT_NOT_USED, MaxUint256, { value: ethSpent2 })
      expect(await tokenA.balanceOf(router.address)).to.equal(pairA.buy(ethSpent2).add(totalTokensOfTrader1))

      await expect(router.sellAndWithdraw(tokenA.address, totalTokensOfTrader1.add(10), LIMIT_NOT_USED, MaxUint256)).to.be.revertedWith("SafeMath: subtraction overflow")
    })

    it("Getting reward estimate fails if token is not owned", async () => {
      let { router, trader, tokenA } = await loadFixture(fixture)

      router = router.connect(trader)
      await expect(router.estimateReward(trader.address, tokenA.address, tokenAmount(1), tokenAmount(1))).to.be.revertedWith("b4")
    })

    it("Empty safelist reverts", async () => {
      let { uniswapRouter, trader } = await loadFixture(fixture)
      await expect(deployContract(trader, VanillaRouter, [uniswapRouter.address, tokenAmount(100), []])).to.be.revertedWith("b6")
    })

    it("Safelist cannot contain tokens not available in Uniswap", async () => {
      let { uniswapRouter, trader } = await loadFixture(fixture)
      const tokenX = await deployContract(trader, ERC20, [tokenAmount(10000)])
      await expect(deployContract(trader, VanillaRouter, [uniswapRouter.address, tokenAmount(100), [tokenX.address]])).to.be.revertedWith("a2")
    })

    it("No reward for tokens not in safelist", async () => {
      let { router, trader, trader2, tokenB, pairB, VNL, WETH } = await loadFixture(fixture)

      router = router.connect(trader)
      let epoch = 13
      let ethSpent = tokenAmount(10)
      let expectedTokens = pairB.buy(ethSpent)
      await router.depositAndBuy(tokenB.address, LIMIT_NOT_USED, MaxUint256, { value: ethSpent })
      let { ethSum, tokenSum, weightedBlockSum, latestBlock } = await router.tokenPriceData(trader.address, tokenB.address)

      // trader2 buys a lot more, which drives the price up and lets trader1 to sell for profit
      let expectedTokens2 = pairB.buy(tokenAmount(100))
      let tx = await router.connect(trader2).depositAndBuy(tokenB.address, LIMIT_NOT_USED, MaxUint256, { value: tokenAmount(100) })
      let receipt = await tx.wait()

      let expectedWETH = BigInt(pairB.sell(tokenSum))
      let wethReserve = await router.wethReserves(tokenB.address)
      let profit = expectedWETH - BigInt(ethSpent)
      let reward = 0

      // weth reserve for tokens not in safelist is 0
      expect(wethReserve).to.equal(0)
      // no reward for tokens not in safelist
      await expect(router.sell(tokenB.address, tokenSum, LIMIT_NOT_USED, MaxUint256))
        .to.emit(router, "TokensSold")
        .withArgs(trader.address, tokenB.address, tokenSum, expectedWETH, profit, reward, wethReserve)

      expect(await WETH.balanceOf(trader.address)).to.equal(tokenAmount("14.161042504234076055")).and.to.equal(expectedWETH)
      expect(await VNL.balanceOf(trader.address)).to.equal(tokenAmount(0)).and.to.equal(reward)
    })
  })

  describe("Internal state", async () => {
    it("Buying token updates data for calculating average prices, holding ratio, and limiting trades per block", async () => {
      let { router, trader, tokenA, pairA } = await loadFixture(fixture)

      router = router.connect(trader)

      let ethSpent = tokenAmount(5)
      let expectedTokens = pairA.buy(ethSpent)
      let receipt = await (await router.depositAndBuy(tokenA.address, LIMIT_NOT_USED, MaxUint256, { value: ethSpent })).wait()
      let block1 = receipt.blockNumber
      {
        let { ethSum, tokenSum, weightedBlockSum, latestBlock } = await router.tokenPriceData(trader.address, tokenA.address)
        expect(ethSum).to.equal(ethSpent)
        expect(tokenSum).to.equal(expectedTokens)
        expect(weightedBlockSum).to.equal(expectedTokens.mul(block1))
        expect(latestBlock).to.equal(block1)
      }

      let ethSpent2 = tokenAmount(10)
      let expectedTokens2 = pairA.buy(ethSpent2)
      receipt = await (await router.depositAndBuy(tokenA.address, LIMIT_NOT_USED, MaxUint256, { value: ethSpent2 })).wait()
      let block2 = receipt.blockNumber

      let { ethSum, tokenSum, weightedBlockSum, latestBlock } = await router.tokenPriceData(trader.address, tokenA.address)
      expect(ethSum).to.equal(tokenAmount(15))
      expect(tokenSum).to.equal(expectedTokens.add(expectedTokens2))
      expect(weightedBlockSum).to.equal(expectedTokens.mul(block1).add(expectedTokens2.mul(block2)))
      expect(latestBlock).to.equal(block2)
    })

    it("Selling token updates token price data and calculates the rewards", async () => {
      let { router, trader, trader2, tokenA, pairA, VNL, WETH } = await loadFixture(fixture)

      router = router.connect(trader)
      let epoch = 13
      let reserveLimit = 100n * 10n ** 18n
      expect(await router.epoch()).to.equal(epoch)
      expect(await router.reserveLimit()).to.equal(reserveLimit)

      let ethSpent = tokenAmount(10)
      let expectedTokens = pairA.buy(ethSpent)
      await router.depositAndBuy(tokenA.address, LIMIT_NOT_USED, MaxUint256, { value: ethSpent })
      let { ethSum, tokenSum, weightedBlockSum, latestBlock } = await router.tokenPriceData(trader.address, tokenA.address)

      // trader2 buys a lot more, which drives the price up and lets trader1 to sell for profit
      let expectedTokens2 = pairA.buy(tokenAmount(100))
      let tx = await router.connect(trader2).depositAndBuy(tokenA.address, LIMIT_NOT_USED, MaxUint256, { value: tokenAmount(100) })
      let receipt = await tx.wait()

      // reward formula: R = P*V*H = (P * (W - P - L) * Bhold²) / W / Btrade²
      let expectedWETH = BigInt(pairA.sell(tokenSum))
      let wethReserve = BigInt(await router.wethReserves(tokenA.address))
      let profit = expectedWETH - BigInt(ethSpent)
      let currentBlock = BigInt(receipt.blockNumber + 1)
      let Bhold = currentBlock - BigInt(weightedBlockSum.div(tokenSum))
      let Btrade = currentBlock - BigInt(epoch)
      let reward = (profit * (wethReserve - profit - reserveLimit) * (Bhold ** 2n)) / wethReserve / (Btrade ** 2n)
      // trader1 sells all the tokens
      await expect(router.sell(tokenA.address, tokenSum, LIMIT_NOT_USED, MaxUint256))
        .to.emit(router, "TokensSold")
        .withArgs(trader.address, tokenA.address, tokenSum, expectedWETH, profit, reward, tokenAmount(10 + 500))

      expect(await WETH.balanceOf(trader.address)).to.equal(tokenAmount("14.161042504234076055")).and.to.equal(expectedWETH)
      expect(await VNL.balanceOf(trader.address)).to.equal(tokenAmount("827800.564712710093")).and.to.equal(reward)
    })

    it("isTokenRewarded returns true if token is on safelist", async () => {
      let { router, tokenA, tokenB } = await loadFixture(fixture)

      expect(await router.isTokenRewarded(tokenA.address)).to.equal(true)
      expect(await router.isTokenRewarded(tokenB.address)).to.equal(false)
    })
  })

  describe("Reward algorithm", async () => {
    // if you wonder if 2^32 is unrealistically low upper limit for block.number testing, consider that currently block.number is
    // at #11911871 (2021-02-23), so with current blockrate (~6500b/d) the block.number > 2^32 would be reached in ~1805 years,
    // or in 10 years if the blockrate grows to 1173439 blocks/d.
    let epoch = constant(11911871n)
    let avgBlock = bigUintN(32)
    let currentBlock = bigUintN(32)

    // if you wonder if 2^90 is unrealistically low upper limit for WETH reserve testing, it equals to 1237940039 ether
    let reserveLimit = constant(500n * (10n ** 18n)) // 500ETH
    let wethReserve = bigUintN(90)
    let profit = bigUintN(90)

    let allRandom = tuple(profit, epoch, avgBlock, currentBlock, reserveLimit, wethReserve)
    let variableBlocks = tuple(epoch, avgBlock, currentBlock)
    let variableReserveSizes = tuple(profit, bigUintN(90), wethReserve)

    it("Theoretical maximum reward = the profit in Ether", async () => {
      const { testRouter } = await loadFixture(fixture)

      await assert(asyncProperty(allRandom, async ([profit, epoch, avgBlock, currentBlock, reserveLimit, wethReserve]) => {
        pre(epoch < avgBlock && epoch < currentBlock && avgBlock <= currentBlock)
        pre(profit < wethReserve)

        let reward = await testRouter.calculateReward(epoch, avgBlock, currentBlock, profit, wethReserve, reserveLimit)
        expect(reward).to.be.lte(profit)
      }))
    })

    it("Holding/Trading Ratio, Squared = ((Bmax-Bavg)/(Bmax-Bmin))²", async () => {
      const { testRouter } = await loadFixture(fixture)

      await assert(asyncProperty(variableBlocks, async ([epoch, avgBlock, currentBlock]) => {
        pre(epoch < avgBlock && epoch < currentBlock && avgBlock <= currentBlock)

        // maximize and fix the value-protection coefficient % so we can isolate the HTRS calculation for testing
        let profit = 10000n
        let reward: BigNumber = await testRouter.calculateReward(epoch, avgBlock, currentBlock, profit, 2n ** 90n, 1n)

        /*
            Bhold = Bmax-Bavg = number of blocks the trade has been held (instead of traded)
            Btrade= Bmax-Bmin = max possible trading time in blocks
            H     = "Holding/Trading Ratio, Squared" (HTRS)
                  = ((Bmax-Bavg)/(Bmax-Bmin))²
                  = (((Bmax-Bmin)-(Bavg-Bmin))/(Bmax-Bmin))²
                  = (Bhold/Btrade)² (= 0 if Bmax = Bavg, NaN if Bmax = Bmin)
         */
        let bhold = currentBlock - avgBlock
        let btrade = currentBlock - epoch
        let htrsTimesProfit = Number(profit * (bhold ** 2n) / (btrade ** 2n))
        expect(reward.toNumber()).to.equal(htrsTimesProfit)
      }))
    })

    it("Value Protection Coefficient = 1-max((P + L)/W, 1)", async () => {
      const { testRouter } = await loadFixture(fixture)

      await assert(asyncProperty(variableReserveSizes, async ([profit, wethReserve, reserveLimit]) => {
        // maximize and fix the HTRS % so we can isolate the VPC calculation for testing
        let reward: BigNumber = await testRouter.calculateReward(1, 1, 100, profit, wethReserve, reserveLimit)

        /*
            P     = absolute profit in Ether = `profit`
            L     = WETH reserve limit for any traded token = `_reserveLimit`
            W     = internally tracked WETH reserve size for when selling a token = `wethReserve`
            V     = value protection coefficient
                  = 1-min((P + L)/W, 1) (= 0 if P+L > W)
         */
        if (profit + reserveLimit > wethReserve) {
          expect(reward.toNumber()).to.equal(0)
        } else {
          /**
           * if P+L<=W, then VPC * profit =
           * P*V = P*(1-(P+L)/W)
           *     = P - (P²+P*L)/W
           *     = (P*W - (P² + P*L))/W
           *     = P*(W - P - L)/W
           */
          let vpcTimesProfit = profit * (wethReserve - profit - reserveLimit) / wethReserve
          expect(BigInt(reward.toHexString())).to.equal(vpcTimesProfit)
        }
      }))
    })
  })
})
