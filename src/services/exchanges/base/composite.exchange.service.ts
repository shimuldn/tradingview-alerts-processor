import { Ticker } from 'ccxt';
import { Account } from '../../../entities/account.entities';
import { TickerFetchError } from '../../../errors/exchange.errors';
import {
  TICKER_BALANCE_READ_SUCCESS,
  TICKER_BALANCE_READ_ERROR
} from '../../../messages/exchanges.messages';
import { getAccountId } from '../../../utils/account.utils';
import { getSpotSymbol } from '../../../utils/trading/symbol.utils';
import { debug, error } from '../../logger.service';
import { FuturesExchangeService } from './futures.exchange.service';

// FIXME can be replaced by a mixin
export abstract class CompositeExchangeService extends FuturesExchangeService {
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
  // above declaration is the same as SpotExchangeService since I'm not playing with mixins for now
}
