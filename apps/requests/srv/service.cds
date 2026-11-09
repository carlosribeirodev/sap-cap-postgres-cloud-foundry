using { lab.requests as db } from '../db/schema';

@path: 'requests'
@requires: 'authenticated-user'
service RequestsService {
  @restrict: [
    { grant: 'READ', to: ['RequestsViewer', 'RequestsEditor'] },
    { grant: ['CREATE', 'UPDATE', 'DELETE'], to: 'RequestsEditor' }
  ]
  entity Requests as projection on db.Requests;
}
