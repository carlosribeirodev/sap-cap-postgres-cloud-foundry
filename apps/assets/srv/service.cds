using { lab.assets as db } from '../db/schema';

@path: 'assets'
@requires: 'authenticated-user'
service AssetsService {
  @restrict: [
    { grant: 'READ', to: ['AssetsViewer', 'AssetsEditor'] },
    { grant: ['CREATE', 'UPDATE', 'DELETE'], to: 'AssetsEditor' }
  ]
  entity Assets as projection on db.Assets;
}
