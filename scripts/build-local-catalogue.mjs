import { fileURLToPath } from 'node:url';
import { CatalogueStore } from './catalogue/store.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const store=new CatalogueStore(root);store.seed();
console.log(JSON.stringify(store.report(),null,2));store.close();
