import { ExchangeId } from '../../constants/exchanges.constants';
import { Account } from '../../entities/account.entities';
import { getAccountId } from '../../utils/account.utils';
import { Exchange, Ticker } from 'ccxt';
import {
  getInvertedTradeSide,
  getTradeSide,
  isSideDifferent
} from '../../utils/trading.utils';
import { Side } from '../../constants/trading.constants';
import { IOrderOptions } from '../../interfaces/trading.interfaces';
import {
  POSITIONS_READ_ERROR,
  POSITIONS_READ_SUCCESS,
  NO_CURRENT_POSITION,
  POSITION_READ_SUCCESS,
  TICKER_BALANCE_READ_ERROR,
  TICKER_BALANCE_READ_SUCCESS,
  BALANCES_READ_ERROR,
  BALANCES_READ_SUCCESS
} from '../../messages/exchanges.messages';
import { debug, error, info } from '../logger.service';
import {
  BalancesFetchError,
  PositionsFetchError,
  TickerFetchError
} from '../../errors/exchange.errors';
import { Trade } from '../../entities/trade.entities';
import { isFTXSpot } from '../../utils/exchanges/ftx.exchange.utils';
import {
  OPEN_TRADE_ERROR_MAX_SIZE,
  REVERSING_TRADE,
  TRADE_OVERFLOW
} from '../../messages/trading.messages';
import {
  NoOpenPositionError,
  OpenPositionError
} from '../../errors/trading.errors';
import { CompositeExchangeService } from './base/composite.exchange.service';
import {
  IFTXBalance,
  IFTXFuturesPosition
} from '../../interfaces/exchanges/ftx.exchange.interfaces';
import { IBalance } from '../../interfaces/exchanges/common.exchange.interfaces';
import {
  getRelativeTradeSize,
  getSpotSymbol,
  getTokensAmount,
  getTokensPrice
} from '../../utils/exchanges/common.exchange.utils';

export class FTXExchangeService extends CompositeExchangeService {
  constructor() {
    super(ExchangeId.FTX);
  }

  getBalances = async (
    account: Account,
    instance?: Exchange
  ): Promise<IBalance[]> => {
    const accountId = getAccountId(account);
    try {
      if (!instance) {
        instance = (await this.refreshSession(account)).exchange;
      }
      const balances = await instance.fetch_balance();
      debug(BALANCES_READ_SUCCESS(this.exchangeId, accountId));
      return balances.info.result
        .filter((b: IFTXBalance) => Number(b.total))
        .map((b: IFTXBalance) => ({
          coin: b.coin,
          free: b.free,
          total: b.total
        }));
    } catch (err) {
      error(BALANCES_READ_ERROR(this.exchangeId, accountId), err);
      throw new BalancesFetchError(
        BALANCES_READ_ERROR(this.exchangeId, accountId, err.message)
      );
    }
  };

  getTickerBalance = async (
    account: Account,
    ticker: Ticker
  ): Promise<number> => {
    const accountId = getAccountId(account);
    const symbol = getSpotSymbol(ticker.symbol);
    try {
      const balances = await this.getBalances(account);
      const balance = balances.filter((b) => b.coin === symbol).pop();
      const size = Number(balance.free);
      debug(
        TICKER_BALANCE_READ_SUCCESS(this.exchangeId, accountId, symbol, balance)
      );
      return size;
    } catch (err) {
      error(TICKER_BALANCE_READ_ERROR(this.exchangeId, accountId, symbol, err));
      throw new TickerFetchError(
        TICKER_BALANCE_READ_ERROR(this.exchangeId, accountId, symbol, err)
      );
    }
  };

  getCloseOrderOptions = async (
    account: Account,
    ticker: Ticker,
    trade: Trade
  ): Promise<IOrderOptions> => {
    const { size } = trade;
    const { symbol, info } = ticker;
    const { price } = info;
    // we add a check since FTX is a composite exchange
    if (isFTXSpot(ticker)) {
      const balance = await this.getTickerBalance(account, ticker);
      return {
        side: Side.Sell,
        size: size
          ? size.includes('%')
            ? getRelativeTradeSize(ticker, balance, size) // handle percentage
            : getTokensAmount(symbol, price, Number(size)) // handle absolute
          : balance // default 100%
      };
    }
    const position = await this.getTickerPosition(account, ticker);
    const current = Number(position.size);
    if (position) {
      return {
        size: size.includes('%')
          ? getRelativeTradeSize(ticker, current, size) // handle percentage
          : Number(size) > price // if closing size > current
          ? current // then close all
          : getTokensAmount(symbol, price, Number(size)), // otherwise handle absolute
        side: getInvertedTradeSide(position.side as Side)
      };
    }
  };

  getTickerPosition = async (
    account: Account,
    ticker: Ticker
  ): Promise<IFTXFuturesPosition> => {
    const { symbol } = ticker;
    const accountId = getAccountId(account);
    const positions = await this.getPositions(account);
    const position = positions.filter((p) => p.future === symbol).pop();
    if (!position) {
      error(NO_CURRENT_POSITION(accountId, this.exchangeId, symbol));
      throw new NoOpenPositionError(
        NO_CURRENT_POSITION(accountId, this.exchangeId, symbol)
      );
    }
    debug(POSITION_READ_SUCCESS(accountId, this.exchangeId, symbol, position));
    return position;
  };

  getTickerPositionSize = async (
    account: Account,
    ticker: Ticker
  ): Promise<number> => {
    const position = await this.getTickerPosition(account, ticker);
    return Number(position.cost);
  };

  getPositions = async (account: Account): Promise<IFTXFuturesPosition[]> => {
    const accountId = getAccountId(account);
    try {
      const accountInfos = await this.sessions
        .get(accountId)
        .exchange.privateGetAccount();
      const positions = accountInfos.result.positions.filter(
        (p: IFTXFuturesPosition) => Number(p.size)
      );
      debug(POSITIONS_READ_SUCCESS(accountId, this.exchangeId, positions));
      return positions;
    } catch (err) {
      error(POSITIONS_READ_ERROR(accountId, this.exchangeId), err);
      throw new PositionsFetchError(
        POSITIONS_READ_ERROR(accountId, this.exchangeId, err.message)
      );
    }
  };

  handleReverseOrder = async (
    account: Account,
    ticker: Ticker,
    trade: Trade
  ): Promise<void> => {
    const { direction } = trade;
    const accountId = getAccountId(account);
    try {
      const position = await this.getTickerPosition(account, ticker);
      if (position && isSideDifferent(position.side as Side, direction)) {
        info(REVERSING_TRADE(this.exchangeId, accountId, ticker.symbol));
        await this.closeOrder(account, trade, ticker);
      }
    } catch (err) {
      // ignore throw
    }
  };

  // TODO extract
  handleMaxBudget = async (
    account: Account,
    ticker: Ticker,
    trade: Trade
  ): Promise<void> => {
    const { max, direction, size } = trade;
    const { symbol } = ticker;
    const accountId = getAccountId(account);
    const side = getTradeSide(direction);
    // we add a check since FTX is a composite exchange
    try {
      let current = 0;
      if (isFTXSpot(ticker)) {
        const balance = await this.getTickerBalance(account, ticker);
        current = this.getOrderCost(ticker, balance);
      } else {
        current = await this.getTickerPositionSize(account, ticker);
      }
      if (Math.abs(current) + Number(size) > Number(max)) {
        error(
          OPEN_TRADE_ERROR_MAX_SIZE(
            this.exchangeId,
            accountId,
            symbol,
            side,
            max
          )
        );
        throw new OpenPositionError(
          OPEN_TRADE_ERROR_MAX_SIZE(
            this.exchangeId,
            accountId,
            symbol,
            side,
            max
          )
        );
      }
    } catch (err) {
      // silent
    }
  };

  handleOverflow = async (
    account: Account,
    ticker: Ticker,
    trade: Trade
  ): Promise<boolean> => {
    const { direction, size } = trade;
    const { symbol, info } = ticker;
    const accountId = getAccountId(account);
    try {
      if (isFTXSpot(ticker)) {
        const balance = await this.getTickerBalance(account, ticker);
        const cost = this.getOrderCost(ticker, balance);
        if (
          cost &&
          getTradeSide(direction) === Side.Sell &&
          cost < Number(size)
        ) {
          info(TRADE_OVERFLOW(this.exchangeId, accountId, symbol));
          await this.closeOrder(
            account,
            { ...trade, size: balance.toString() },
            ticker
          );
          return true;
        }
      } else {
        const position = await this.getTickerPosition(account, ticker);
        const { side, cost } = position;
        if (
          position &&
          isSideDifferent(side as Side, direction) &&
          Number(size) > Math.abs(Number(cost))
        ) {
          info(TRADE_OVERFLOW(this.exchangeId, accountId, symbol));
          await this.closeOrder(account, trade, ticker);
          return true;
        }
      }
    } catch (err) {
      // ignore throw
    }
    return false;
  };

  getOrderCost = (ticker: Ticker, size: number): number => {
    const { symbol, info } = ticker;
    const { price } = info;
    return getTokensPrice(symbol, price, size);
  };
}
