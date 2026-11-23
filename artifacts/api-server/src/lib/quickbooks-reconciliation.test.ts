import {describe,expect,it} from "vitest";
import {customerReconciliationMatches} from "./quickbooks-reconciliation";
describe("customer reconciliation candidates",()=>{
  it("preserves dots and plus tags in email identities",()=>{
    expect(customerReconciliationMatches({customerName:"Alice",email:"a.lice+floor@example.test"},[{Id:"1",DisplayName:"Bob",PrimaryEmailAddr:{Address:"alicefloor@example.test"}}])).toEqual([]);
    expect(customerReconciliationMatches({customerName:"Alice",email:" A.Lice+floor@Example.Test "},[{Id:"2",PrimaryEmailAddr:{Address:"a.lice+floor@example.test"}}])).toEqual([{id:"2",name:undefined,confidence:"exact"}]);
  });
  it("never matches unrelated customers through blank email, phone or name",()=>{
    expect(customerReconciliationMatches({customerName:"Alice",email:"",phone:""},[{Id:"1",DisplayName:"Bob"},{Id:"2",DisplayName:"Alice"}])).toEqual([{id:"2",name:"Alice",confidence:"suggested"}]);
    expect(customerReconciliationMatches({customerName:"",email:"",phone:""},[{Id:"1"}])).toEqual([]);
  });
  it("keeps duplicate contact matches ambiguous",()=>{
    const rows=[{Id:"1",PrimaryEmailAddr:{Address:"Owner@Example.test"}},{Id:"2",PrimaryEmailAddr:{Address:"owner@example.test"}}];
    expect(customerReconciliationMatches({customerName:"Owner",email:"owner@example.test"},rows).every(row=>row.confidence==="suggested")).toBe(true);
  });
  it("uses a saved external ID before similar contacts and does not silently replace a missing link",()=>{
    const rows=[{Id:"1",DisplayName:"Old name"},{Id:"2",DisplayName:"New name",PrimaryEmailAddr:{Address:"owner@example.test"}}];
    const local={customerName:"New name",email:"owner@example.test"};
    expect(customerReconciliationMatches(local,rows,"1")).toEqual([{id:"1",name:"Old name",confidence:"exact"}]);expect(customerReconciliationMatches(local,rows,"missing")).toEqual([]);
  });
});
