import {
  LayoutDashboard,
  Megaphone,
  FileText,
  Package,
  CreditCard,
  Settings,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  description?: string;
}

export const PRIMARY_NAV: NavItem[] = [
  {
    label: "Dashboard",
    href: "/dashboard",
    icon: LayoutDashboard,
    description: "Intelligence Hub",
  },
  {
    label: "Campaigns",
    href: "/campaigns",
    icon: Megaphone,
    description: "Generate ad briefs",
  },
  {
    label: "Briefs",
    href: "/briefs",
    icon: FileText,
    description: "Your generated briefs",
  },
  {
    label: "Products",
    href: "/products",
    icon: Package,
    description: "Store intelligence",
  },
  {
    label: "Pricing",
    href: "/pricing",
    icon: CreditCard,
    description: "Credits & billing",
  },
  {
    label: "Settings",
    href: "/settings",
    icon: Settings,
    description: "Account & integrations",
  },
];
