using { lab.assets as db } from '../db/schema';

@path: 'assets'
service AssetsService {
  entity Assets as projection on db.Assets;
}
