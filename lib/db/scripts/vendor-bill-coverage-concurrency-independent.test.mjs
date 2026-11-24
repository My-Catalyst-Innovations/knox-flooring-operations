/** Independent actual PostgreSQL trigger races. Synthetic rows only; no HTTP,
 * provider, owner credentials or cloud access. Each losing transaction waits on
 * an observed PostgreSQL lock before the winning transaction commits. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { loadMigrations, loadExpectedColumns, loadExpectedForeignKeys, runMigrations } from './migration-runner.mjs';

const hash='a'.repeat(64),at='2026-11-23T12:00:00.000Z';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('independent real PostgreSQL receipt/bill and canonical provider capacity races', {timeout:120000,skip:!process.env.TEST_DATABASE_URL}, async t=>{
 const source=new URL(process.env.TEST_DATABASE_URL);
 assert.ok(['127.0.0.1','localhost','[::1]'].includes(source.hostname),'Independent races refuse non-loopback PostgreSQL');
 const name='coverage_independent_'+randomUUID().replaceAll('-','');
 assert.match(name,/^coverage_independent_[a-f0-9]{32}$/);
 const target=new URL(source);target.pathname='/'+name;
 const admin=new pg.Client({connectionString:source.href}),database=new pg.Client({connectionString:target.href});
 const checks=[],prefix=randomUUID();let created=false;
 await admin.connect();
 try{
  await admin.query(`CREATE DATABASE "${name}"`);created=true;await database.connect();
  const migrations=await loadMigrations();
  await runMigrations(database,{migrations,expectedColumns:await loadExpectedColumns(),expectedForeignKeys:await loadExpectedForeignKeys()});
  assert.equal(migrations.at(-1).id,'0031_vendor_bill_receipt_allocations');
  const product=prefix+'-product',warehouse=prefix+'-warehouse',alias=prefix+'-alias',price=prefix+'-price';
  await database.query("INSERT INTO products(id,name,category,sku,unit,created_at,updated_at) VALUES($1,'Fictional independent material','Tile','000081','sqft',$2,$2)",[product,at]);
  await database.query("INSERT INTO warehouses(id,name,created_at,updated_at) VALUES($1,'Fictional independent warehouse',$2,$2)",[warehouse,at]);
  await database.query("INSERT INTO supplier_product_aliases(id,product_id,supplier,supplier_key,supplier_sku,supplier_sku_key,approved_by,approved_at) VALUES($1,$2,'Fictional Independent Supply','fictional independent supply','000001','000001','synthetic-owner',$3)",[alias,product,at]);
  await database.query("INSERT INTO supplier_buy_prices(id,alias_id,unit,unit_cost,effective_on,source,approved_by,approved_at) VALUES($1,$2,'sqft','2.000001','2026-11-23','Fictional independent test','synthetic-owner',$3)",[price,alias,at]);
  async function receipt(quantity='10'){
   const id=randomUUID(),order=id+'-po',orderLine=id+'-line',header=id+'-header',movement=id+'-movement';
   await database.query("INSERT INTO purchase_orders(id,warehouse_id,supplier,notes,status,created_by,created_at,updated_at) VALUES($1,$2,'Fictional Independent Supply','Fictional independent fixture','Received','synthetic-owner',$3,$3)",[order,warehouse,at]);
   await database.query("INSERT INTO purchase_order_lines(id,order_id,product_id,product_name,sku,unit,position,quantity,unit_cost) VALUES($1,$2,$3,'Fictional independent material','000081','sqft',0,$4,'2.000001')",[orderLine,order,product,quantity]);
   await database.query("INSERT INTO purchase_receipts(id,order_id,reference,request_key,request_hash,received_by,received_at) VALUES($1,$2,'Fictional original receipt',$1,$3,'synthetic-owner',$4)",[header,order,hash,at]);
   await database.query("INSERT INTO inventory_movements(id,product_id,warehouse_id,quantity,kind,acquisition_unit_cost,reason,actor_user_id,idempotency_key,created_at) VALUES($1,$2,$3,$4,'receipt','2.000001','Fictional independent acquisition','synthetic-owner',$1,$5)",[movement,product,warehouse,quantity,at]);
   await database.query("INSERT INTO purchase_receipt_lines(id,receipt_id,line_id,movement_id,quantity) VALUES($1,$2,$3,$4,$5)",[id,header,orderLine,movement,quantity]);
   return id;
  }
  async function bill({quantity='10',realm=null,posted='2001',number='000078'}={}){
   const id=randomUUID(),source={mode:realm?'sandbox':'review',supplier:'Fictional Independent Supply',billNumber:number,billDate:'2026-11-23',lines:[{internalSku:'000081',quantity,billedUnitCost:'2.000001'}],...(realm?{realmId:realm,quickBooksBill:{VendorRef:{value:'3001'},Line:[{ItemBasedExpenseLineDetail:{ItemRef:{value:'1001'}}}]}}:{})};
   const payload={...source,...(realm?{postedId:posted}:{})};
   await database.query("INSERT INTO quickbooks_sync_jobs(id,idempotency_key,entity_type,local_id,action,status,payload,created_at,updated_at) VALUES($1,$1,'vendor_bill',$1,'create',$2,$3,$4,$4)",[id,realm?'completed':'reviewed',payload,at]);
   return {id,source,quantity,realm,posted};
  }
  async function approval(realm=null){
   const id=randomUUID(),connection=realm?'synthetic-connection-'+realm:null;
   await database.query("INSERT INTO vendor_bill_coverage_approvals(id,request_key,request_fingerprint,fingerprint,mode,workspace_key,connection_id,realm_id,environment,choice,source_snapshot,note,created_by,created_at) VALUES($1,$1,$2,$2,$3,'independent-fixture',$4,$5,$6,'{}','{}','Synthetic independent owner reviewed exact sources','synthetic-owner',$7)",[id,hash,realm?'quickbooks_verified':'local_review',connection,realm,realm?'sandbox':null,at]);
   return {id,connection};
  }
  function allocationInsert(client,{receiptId,bill:source,approval:decision,quantity='6'}){
   const id=randomUUID();
   return client.query("INSERT INTO vendor_bill_receipt_allocations(id,approval_id,receipt_line_id,bill_id,bill_line_index,product_id,alias_id,price_id,mode,stock_unit,quantity,receipt_unit_cost,billed_unit_cost,bill_line_quantity,bill_source,bill_source_fingerprint,receipt_snapshot,identity_snapshot,variance_note,created_at) VALUES($1,$2,$3,$4,0,$5,$6,$7,'local_review','sqft',$8,'2.000001','2.000001',$9,$10,$11,'{}','{}','',$12) RETURNING id",[id,decision.id,receiptId,source.id,product,alias,price,quantity,source.quantity,source.source,hash,at]);
  }
  function bindingInsert(client,{allocationId,bill:source,approval:decision,quantity='6'}){
   return client.query("INSERT INTO vendor_bill_coverage_bindings(id,approval_id,allocation_id,bill_id,bill_line_index,connection_id,realm_id,environment,vendor_id,item_id,posted_bill_id,quantity,bill_line_quantity,billed_unit_cost,bill_source,bill_source_fingerprint,provider_snapshot,identity_snapshot,variance_note,reconciliation_note,created_at) VALUES($1,$2,$3,$4,0,$5,$6,'sandbox','3001','1001',$7,$8,$9,'2.000001',$10,$11,'{}','{}','','',$12)",[randomUUID(),decision.id,allocationId,source.id,decision.connection,source.realm,source.posted,quantity,source.quantity,source.source,hash,at]);
  }
  async function base(receiptId,quantity='10'){
   const source=await bill({quantity}),decision=await approval();
   const result=await allocationInsert(database,{receiptId,bill:source,approval:decision,quantity});return result.rows[0].id;
  }
  async function contested(label,first,second,pattern){
   const a=new pg.Client({connectionString:target.href,application_name:'independent-coverage-winner'}),b=new pg.Client({connectionString:target.href,application_name:'independent-coverage-competitor'});
   let losing;
   await a.connect();await b.connect();
   try{
    await a.query("BEGIN; SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='15s'");
    await b.query("BEGIN; SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='15s'");
    const pid=(await b.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    await first(a);
    losing=second(b).then(()=>({ok:true}),error=>({ok:false,error}));
    let waited=false;
    for(let attempt=0;attempt<200;attempt++){
     const row=(await database.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0];
     if(row?.wait_event_type==='Lock'){waited=true;break;}
     await pause(10);
    }
    assert.equal(waited,true,label+': competitor must actually wait on a PostgreSQL lock');
    await a.query('COMMIT');
    const result=await losing;
    assert.equal(result.ok,false,label+': second transaction must not overallocate after wait');
    assert.equal(result.error.code,'23514',label+': actual quantity constraint must reject competitor');
    assert.match(result.error.message,pattern,label+': rejection must be the intended coverage capacity boundary');
    await b.query('ROLLBACK');checks.push(label);
   }finally{
    await a.query('ROLLBACK').catch(()=>{});await b.query('ROLLBACK').catch(()=>{});
    if(losing)await losing;
    await a.end();await b.end();
   }
  }
  await t.test('two local bills cannot overallocate one receipt after row-lock wait',async()=>{
   const r=await receipt(),b1=await bill(),b2=await bill(),a1=await approval(),a2=await approval();
   await contested('same_receipt_different_local_bills',c=>allocationInsert(c,{receiptId:r,bill:b1,approval:a1}),c=>allocationInsert(c,{receiptId:r,bill:b2,approval:a2}),/exceeds the exact accepted receipt quantity/);
   assert.equal((await database.query('SELECT sum(quantity)::text n FROM vendor_bill_receipt_allocations WHERE receipt_line_id=$1',[r])).rows[0].n,'6.000000');
  });
  await t.test('two receipts cannot overallocate one local bill after bill-row wait',async()=>{
   const r1=await receipt(),r2=await receipt(),source=await bill(),a1=await approval(),a2=await approval();
   await contested('same_local_bill_different_receipts',c=>allocationInsert(c,{receiptId:r1,bill:source,approval:a1}),c=>allocationInsert(c,{receiptId:r2,bill:source,approval:a2}),/exceeds the original local bill merchandise quantity/);
   assert.equal((await database.query('SELECT sum(quantity)::text n FROM vendor_bill_receipt_allocations WHERE bill_id=$1',[source.id])).rows[0].n,'6.000000');
  });
  await t.test('provider endorsements across different companies consume one original base globally',async()=>{
   const r=await receipt(),allocationId=await base(r),b1=await bill({realm:'777'}),b2=await bill({realm:'888',posted:'2002'}),a1=await approval('777'),a2=await approval('888');
   await contested('same_base_endorsement_across_companies',c=>bindingInsert(c,{allocationId,bill:b1,approval:a1}),c=>bindingInsert(c,{allocationId,bill:b2,approval:a2}),/exceeds the original stock coverage across companies/);
   assert.equal((await database.query('SELECT sum(quantity)::text n FROM vendor_bill_coverage_bindings WHERE allocation_id=$1',[allocationId])).rows[0].n,'6.000000');
   assert.equal((await database.query('SELECT quantity::text n FROM vendor_bill_receipt_allocations WHERE id=$1',[allocationId])).rows[0].n,'10.000000');
  });
  await t.test('different physical bases cannot overendorse one provider bill line',async()=>{
   const r1=await receipt(),r2=await receipt(),base1=await base(r1),base2=await base(r2),source=await bill({realm:'777',posted:'2003'}),a1=await approval('777'),a2=await approval('777');
   await contested('same_provider_bill_different_bases',c=>bindingInsert(c,{allocationId:base1,bill:source,approval:a1}),c=>bindingInsert(c,{allocationId:base2,bill:source,approval:a2}),/exceeds the posted bill line quantity/);
   assert.equal((await database.query('SELECT sum(quantity)::text n FROM vendor_bill_coverage_bindings WHERE bill_id=$1',[source.id])).rows[0].n,'6.000000');
  });
  await t.test('duplicate queue IDs for the same provider bill share one canonical capacity and lock',async()=>{
   const r1=await receipt(),r2=await receipt(),base1=await base(r1),base2=await base(r2),b1=await bill({realm:'777',posted:'2004'}),b2=await bill({realm:'777',posted:'2004'}),a1=await approval('777'),a2=await approval('777');
   assert.notEqual(b1.id,b2.id);assert.equal(b1.posted,b2.posted);
   await contested('duplicate_queue_same_canonical_provider_line',c=>bindingInsert(c,{allocationId:base1,bill:b1,approval:a1}),c=>bindingInsert(c,{allocationId:base2,bill:b2,approval:a2}),/one immutable queue/);
   assert.equal((await database.query("SELECT sum(quantity)::text n FROM vendor_bill_coverage_bindings WHERE realm_id='777' AND environment='sandbox' AND posted_bill_id='2004' AND bill_line_index=0")).rows[0].n,'6.000000');
   // Quantity alone would allow this one-unit alias. One original queue must
   // also anchor line indices because provider matching permits line reordering.
   await assert.rejects(bindingInsert(database,{allocationId:base2,bill:b2,approval:a2,quantity:'1'}),error=>error.code==='23514'&&/one immutable queue/.test(error.message));
   checks.push('duplicate_queue_refused_despite_unused_quantity_capacity');
  });
  assert.equal((await database.query('SELECT count(*)::int n FROM inventory_movements WHERE kind<>\'receipt\'')).rows[0].n,0);
  assert.equal((await database.query('SELECT count(*)::int n FROM invoices')).rows[0].n,0);
  console.log(JSON.stringify({independentCoverageConcurrency:'passed',checks,actualPostgresql:true,lockWaitObservedForEveryRace:true,migrationId:migrations.at(-1).id,migrationChecksum:migrations.at(-1).checksum,providerRequests:0,httpRequests:0,cloudRequests:0,liveAccountingWrites:0}));
 }finally{
  await database.end().catch(()=>{});
  if(created){assert.match(name,/^coverage_independent_[a-f0-9]{32}$/);await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);}
  await admin.end();
 }
});
