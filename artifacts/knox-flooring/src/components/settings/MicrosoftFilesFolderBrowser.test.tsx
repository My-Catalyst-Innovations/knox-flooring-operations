import { cleanup,fireEvent,render,screen,waitFor } from "@testing-library/react";
import { afterEach,expect,it,vi } from "vitest";
import { MicrosoftFilesFolderBrowser } from "./MicrosoftFilesFolderBrowser";
const mock=vi.hoisted(()=>({operation:vi.fn()}));
vi.mock("@/lib/operations",()=>({operation:mock.operation}));
afterEach(()=>{cleanup();vi.resetAllMocks();});
const root={id:"root",driveId:"drive",key:"a".repeat(64),name:"Catalyst Works",webUrl:"https://company.sharepoint.com/Works"};
const child={id:"jobs",name:"Client jobs",webUrl:"https://company.sharepoint.com/Works/Jobs"};
const page={root,current:root,breadcrumbs:[root],folders:[child],complete:true};
it("browses named approved folders and requires an explicit destination choice",async()=>{
  const selected=vi.fn().mockResolvedValue(undefined);mock.operation.mockResolvedValueOnce(page).mockResolvedValueOnce({...page,current:child,breadcrumbs:[root,child],folders:[]}).mockResolvedValueOnce({});
  render(<MicrosoftFilesFolderBrowser onSelected={selected}/>);expect(mock.operation).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button",{name:"Browse approved company folder"}));
  fireEvent.click(await screen.findByRole("button",{name:"Open Client jobs"}));
  expect(await screen.findByText("Client jobs",{selector:"strong"})).toBeVisible();expect(mock.operation.mock.calls.every(call=>call.length===1)).toBe(true);
  fireEvent.click(screen.getByRole("button",{name:"Use this folder for job files"}));
  await waitFor(()=>expect(mock.operation).toHaveBeenCalledWith("/microsoft/files/target","PUT",{folderPath:["jobs"],rootKey:root.key}));expect(selected).toHaveBeenCalledTimes(1);
});
it("hides stale selection after a failed navigation and does not turn a browsing limit into absence",async()=>{
  mock.operation.mockResolvedValueOnce({...page,complete:false}).mockRejectedValueOnce(new Error("The folder moved."));render(<MicrosoftFilesFolderBrowser onSelected={vi.fn()}/>);
  fireEvent.click(screen.getByRole("button",{name:"Browse approved company folder"}));expect(await screen.findByRole("status")).toHaveTextContent("browsing limit");
  fireEvent.click(screen.getByRole("button",{name:"Open Client jobs"}));expect(await screen.findByRole("alert")).toHaveTextContent("moved");expect(screen.queryByRole("button",{name:"Use this folder for job files"})).not.toBeInTheDocument();
  expect(mock.operation.mock.calls.every(call=>call.length===1)).toBe(true);
});
it("allows viewing a locked destination but cannot retarget existing job folders",async()=>{
  mock.operation.mockResolvedValue(page);render(<MicrosoftFilesFolderBrowser targetLocked onSelected={vi.fn()}/>);fireEvent.click(screen.getByRole("button",{name:"Browse approved company folder"}));
  expect(await screen.findByRole("button",{name:"Use this folder for job files"})).toBeDisabled();expect(screen.getByText(/storage migration review/)).toBeVisible();
});
