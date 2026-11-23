export interface GuideJob {
  id: string;
  jobNumber: string;
  customerName: string;
  status: string;
}
export interface SafeWorkOrder {
  job: GuideJob & {
    address: string;
    city: string;
    flooringType: string;
    scopeOfWork: string;
    rooms: {
      id: string;
      name: string;
      length: number;
      width: number;
    }[];
  };
  tasks: {
    id: string;
    title: string;
    startAt: string;
    endAt: string;
    status: string;
    bookingId: string | null;
  }[];
  bookings: {
    id: string;
    crewId: string;
    crewName: string;
    startAt: string;
    endAt: string;
  }[];
  materials: { id: string; name: string; quantity: number; unit: string }[];
}
export interface WorkGuideStep {
  key: string;
  title: string;
  instruction: string;
  verified: boolean;
  evidence: string;
  href?: string;
  actionLabel?: string;
}
export interface WorkGuide extends SafeWorkOrder {
  installation: WorkGuideStep[];
  warehouse: WorkGuideStep[] | null;
  orders: {
    id: string;
    number: number;
    supplier: string;
    warehouseName: string;
    status: string;
  }[];
  selectedOrderId: string | null;
  ownUpdates: {
    id: string;
    authorName: string;
    message: string;
    createdAt: string;
  }[];
  checkedAt: string;
}
