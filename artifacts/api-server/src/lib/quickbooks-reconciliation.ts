type RemoteCustomer={Id:string;DisplayName?:string;PrimaryEmailAddr?:{Address?:string};PrimaryPhone?:{FreeFormNumber?:string}};
const normalize=(value:unknown)=>String(value??"").trim().toLowerCase().replace(/[^a-z0-9@]/g,"");
const normalizeEmail=(value:unknown)=>String(value??"").trim().toLowerCase();
const normalizePhone=(value:unknown)=>String(value??"").replace(/\D/g,"");
export function customerReconciliationMatches(local:{email?:string|null;phone?:string|null;customerName:string},customers:RemoteCustomer[],savedId?:string) {
  if(savedId)return customers.filter(row=>row.Id===savedId).map(row=>({id:row.Id,name:row.DisplayName,confidence:"exact"}));
  const email=normalizeEmail(local.email),phone=normalizePhone(local.phone),name=normalize(local.customerName);
  const matches=customers.filter(row=>(email&&normalizeEmail(row.PrimaryEmailAddr?.Address)===email)||(phone&&normalizePhone(row.PrimaryPhone?.FreeFormNumber)===phone)||(name&&normalize(row.DisplayName)===name));
  return matches.map(row=>({id:row.Id,name:row.DisplayName,confidence:matches.length===1&&email&&normalizeEmail(row.PrimaryEmailAddr?.Address)===email?"exact":"suggested"}));
}
