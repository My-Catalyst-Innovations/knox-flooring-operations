import {beforeEach,describe,expect,it,vi} from "vitest";
const mocks=vi.hoisted(()=>({connection:{} as any,link:{} as any,invoice:{} as any,atTransaction:()=>{},updates:[] as any[],locks:vi.fn()}));
vi.mock("@workspace/db/workspace",()=>({workspaceEnvironment:()=>process.env,workspaceScopeKey:()=>"test"}));
vi.mock("@workspace/db",async()=>{
  const schema=await import("../../../../lib/db/src/schema/index");const {getTableName}=await import("drizzle-orm");const {PgDialect}=await import("drizzle-orm/pg-core");const dialect=new PgDialect();
  const rows=(table:any)=>{const name=getTableName(table);return name==="invoices"?[structuredClone(mocks.invoice)]:name==="quickbooks_connections"?[structuredClone(mocks.connection)]:name==="quickbooks_entity_mappings"?[structuredClone(mocks.link)]:[];};
  const db:any={select:()=>({from:(table:any)=>({where:()=>({limit:async()=>rows(table),for:async()=>rows(table)})})}),execute:mocks.locks,
    update:(table:any)=>({set:(values:any)=>({where:(condition:any)=>{
      const name=getTableName(table),params=dialect.sqlToQuery(condition).params;
      const ok=name!=="invoices"||params[1]===mocks.invoice.updatedAt;
      return {
        returning:async()=>{if(!ok)return [];mocks.updates.push({name,values});return [{id:"invoice1"}];},
        then:(resolve:any)=>{if(ok)mocks.updates.push({name,values});return Promise.resolve().then(resolve);},
      };
    }})}),
  };db.transaction=async(fn:any)=>{mocks.atTransaction();return fn(db);};return {...schema,db};
});
vi.mock("./auth",()=>({audit:vi.fn()}));
vi.mock("./quickbooks",async importOriginal=>({...await importOriginal<any>(),qboRequest:async()=>({Invoice:{Id:"remote1",TotalAmt:100,Balance:20,SyncToken:"2"}})}));
import {importInvoice} from "./quickbooks-worker";
describe("in-flight QuickBooks invoice imports",()=>{
  beforeEach(()=>{mocks.connection={id:"connection-a",realmId:"123",environment:"sandbox",status:"connected"};mocks.link={id:"link1",entityType:"invoice",localId:"invoice1",quickbooksId:"remote1",realmId:"123",environment:"sandbox",status:"linked"};mocks.invoice={id:"invoice1",updatedAt:"2026-11-22",depositAmount:0,refundedAmount:0,status:"Sent",dueDate:"2026-12-22"};mocks.atTransaction=()=>{};mocks.updates=[];mocks.locks.mockReset();});
  it("updates payment and mapping together while locking the selected company",async()=>{await importInvoice("remote1",structuredClone(mocks.connection));expect(mocks.locks).toHaveBeenCalledOnce();expect(mocks.updates.map(row=>row.name)).toEqual(["invoices","quickbooks_entity_mappings"]);expect(mocks.updates[0].values).toMatchObject({paidAmount:80,balanceAmount:20});});
  it("rejects a connection that changed while the remote invoice was loading",async()=>{mocks.atTransaction=()=>{mocks.connection.status="disconnected";};await expect(importInvoice("remote1",structuredClone(mocks.connection))).rejects.toThrow(/company changed/);expect(mocks.updates).toEqual([]);});
  it("preserves a concurrent local invoice edit",async()=>{mocks.atTransaction=()=>{mocks.invoice.updatedAt="2026-11-23";};await expect(importInvoice("remote1",structuredClone(mocks.connection))).rejects.toThrow(/local invoice changed/);expect(mocks.updates).toEqual([]);});
  it("rejects an invoice relinked while its previous remote result was loading",async()=>{mocks.atTransaction=()=>{mocks.link.quickbooksId="different";};await expect(importInvoice("remote1",structuredClone(mocks.connection))).rejects.toThrow(/mapping changed/);expect(mocks.updates).toEqual([]);});
});
