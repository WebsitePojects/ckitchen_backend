/**
 * Modules the owner can switch on or off, and the pages each one covers.
 *
 * Core pages (ordering, kitchen, menu, stock, reports, outlets, users, settings) are not
 * listed here: a cloud kitchen cannot run without them, so they can never be switched off.
 * Page keys match admin/rbac-defaults.ts PAGE_ROLES.
 */
export interface BusinessModule {
  key: string;
  label: string;
  description: string;
  pages: readonly string[];
}

export const BUSINESS_MODULES: readonly BusinessModule[] = [
  {
    key: "merchant_console",
    label: "Merchant Console",
    description: "Live GrabFood/foodpanda order control. Useful once the aggregator APIs are connected.",
    pages: ["/merchant-console"],
  },
  {
    key: "channel_listings",
    label: "Channel listings",
    description: "Manage each brand's GrabFood/foodpanda store listings and merchant settings.",
    pages: ["/channel-listings", "/merchant-management"],
  },
  {
    key: "printers",
    label: "Kitchen printers",
    description: "Printer setup and the print monitor. Needs the Print Agent installed in the kitchen.",
    pages: ["/printers"],
  },
  {
    key: "tv_board",
    label: "TV board",
    description: "Big-screen order board for a kitchen TV.",
    pages: ["/tv"],
  },
  {
    key: "purchasing",
    label: "Purchasing",
    description: "Purchase requests and orders, suppliers and master data.",
    pages: ["/purchasing", "/master-data"],
  },
  {
    key: "people",
    label: "People & attendance",
    description: "Employee records and the photo time clock. Off also removes the clock-in gate.",
    pages: ["/employees", "/attendance"],
  },
  {
    key: "audit",
    label: "Audit log",
    description: "Who changed what, and when.",
    pages: ["/audit"],
  },
];

const MODULE_BY_KEY = new Map(BUSINESS_MODULES.map((m) => [m.key, m]));

export function findModule(key: string): BusinessModule | undefined {
  return MODULE_BY_KEY.get(key);
}
