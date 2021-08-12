import { ExchangeId } from '../../constants/exchanges.constants';
import { SpotExchangeService } from './base/spot.exchange.service';

// TODO replace by a composite exchange
export class KrakenExchangeService extends SpotExchangeService {
  constructor() {
    super(ExchangeId.Kraken);
  }
}
