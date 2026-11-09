namespace lab.assets;
using { cuid, managed } from '@sap/cds/common';

entity Assets : cuid, managed {
  name         : String(120) not null;
  serialNumber : String(80);
}
