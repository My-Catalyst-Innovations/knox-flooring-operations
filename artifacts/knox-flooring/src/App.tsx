import { AppLayout } from "@/components/layout/AppLayout";
import { PrivateWorkspace } from "@/components/layout/PrivateWorkspace";
import { Switch, Route, Redirect, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";

import Dashboard from "@/pages/dashboard";
import Leads from "@/pages/leads";
import LeadDetail from "@/pages/lead-detail";
import Jobs from "@/pages/jobs";
import JobDetail from "@/pages/job-detail";
import WorkOrder from "@/pages/work-order";
import WorkGuides from "@/pages/work-guides";
import Pipeline from "@/pages/pipeline";
import Estimator from "@/pages/estimator";
import Proposals from "@/pages/proposals";
import Schedule from "@/pages/schedule";
import CalendarPage from "@/pages/calendar";
import TaskCalendar from "@/pages/task-calendar";
import SalesPerformance from "@/pages/sales-performance";
import Commissions from "@/pages/commissions";
import Invoices from "@/pages/invoices";
import Customers from "@/pages/customers";
import LegacyHistory from "@/pages/legacy-history";
import CustomerDetail from "@/pages/customer-detail";
import Materials from "@/pages/materials";
import Inventory from "@/pages/inventory";
import PurchaseOrders from "@/pages/purchase-orders";
import WarehouseBins from "@/pages/warehouse-bins";
import PhysicalPieces from "@/pages/physical-pieces";
import Reports from "@/pages/reports";
import Settings from "@/pages/settings";
import Profile from "@/pages/profile";
import PublicStatus from "@/pages/public-status";
import PublicQuote from "@/pages/public-quote";
import PublicPrint from "@/pages/public-print";
import Welcome from "@/pages/welcome";
import CompanySignup from "@/pages/company-signup";
import PlatformBilling from "@/pages/platform-billing";
import PlatformVerify from "@/pages/platform-verify";
import VideoPage from "@/pages/video";
import { AuthProvider, useAuth } from "@/contexts/auth";
import { Loader2 } from "lucide-react";
import IntegrationHealth from "@/pages/integration-health";
import DemoOutbox from "@/pages/demo-outbox";
import Messages from "@/pages/messages";
import TextPreferences from "@/pages/text-preferences";
import AIOperations from "@/pages/ai-operations";

const queryClient = new QueryClient();

function AdminRouter() {
  return (
    <AppLayout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/leads" component={Leads} />
        <Route path="/leads/:id" component={LeadDetail} />
        <Route path="/jobs" component={Jobs} />
        <Route path="/jobs/:id" component={JobDetail} />
        <Route path="/pipeline" component={Pipeline} />
        <Route path="/estimator" component={Estimator} />
        <Route path="/ai-operations" component={AIOperations} />
        <Route path="/proposals" component={Proposals} />
        <Route path="/schedule" component={Schedule} />
        <Route path="/calendar" component={CalendarPage} />
        <Route path="/tasks" component={TaskCalendar} />
        <Route path="/sales" component={SalesPerformance} />
        <Route path="/commissions" component={Commissions} />
        <Route path="/invoices" component={Invoices} />
        <Route path="/customers/:key" component={CustomerDetail} />
        <Route path="/customers" component={Customers} />
        <Route path="/legacy-history" component={LegacyHistory} />
        <Route path="/materials" component={Materials} />
        <Route path="/inventory" component={Inventory} />
        <Route path="/inventory/purchase-orders" component={PurchaseOrders} />
        <Route path="/inventory/bins" component={WarehouseBins} />
        <Route path="/inventory/physical-pieces" component={PhysicalPieces} />
        <Route path="/reports" component={Reports} />
        <Route path="/settings" component={Settings} />
        <Route path="/profile" component={Profile} />
        <Route path="/integration-health" component={IntegrationHealth} />
        <Route path="/demo-outbox" component={DemoOutbox} />
        <Route path="/communications" component={Messages} />
        <Route path="/text-preferences" component={TextPreferences} />
        <Route component={NotFound} />
      </Switch>
    </AppLayout>
  );
}

export function WorkspaceRouter() {
  const { user, loading } = useAuth();
  if (loading) return <div className="flex min-h-screen items-center justify-center"><Loader2 className="h-7 w-7 animate-spin text-primary" /></div>;
  const hasAppAccess = Boolean(user);
  return (
    <Switch>
      <Route path="/video" component={VideoPage} />
      <Route path="/signup" component={CompanySignup} />
      <Route path="/account/billing" component={PlatformBilling} />
      <Route path="/account/verify" component={PlatformVerify} />
      <Route path="/p/:token/print/invoice/:invoiceId">
        {(params) => <PublicPrint key={`${params.token}-inv`} />}
      </Route>
      <Route path="/p/:token/print/:kind" component={PublicPrint} />
      <Route path="/p/:token" component={PublicStatus} />
      <Route path="/q/:token" component={PublicQuote} />
      <Route path="/welcome" component={Welcome} />
      <Route path="/jobs/:id/work-order">
        {() => hasAppAccess ? <WorkOrder /> : <Redirect to="/welcome" />}
      </Route>
      <Route path="/work-guides">
        {() => hasAppAccess ? <WorkGuides /> : <Redirect to="/welcome" />}
      </Route>
      <Route>
        {() => (hasAppAccess ? <PrivateWorkspace><AdminRouter /></PrivateWorkspace> : <Redirect to="/welcome" />)}
      </Route>
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <AuthProvider><WorkspaceRouter /></AuthProvider>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
