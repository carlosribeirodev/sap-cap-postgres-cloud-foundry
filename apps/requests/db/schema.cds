namespace lab.requests;
using { cuid, managed } from '@sap/cds/common';

entity Requests : cuid, managed {
  title       : String(120) not null;
  description : String(1000);
  status      : String(20) default 'OPEN';
}
