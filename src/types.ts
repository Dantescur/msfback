import { AddonId } from "./schemas";

export interface Plan {
  id: string;
  name: string;
  monthly_price: number;
  yearly_price: number;
}

export interface Addon {
  id: AddonId;
  name: string;
  monthly_price: number;
  yearly_price: number;
}

export interface PersonalInfo {
  name: string;
  email: string;
  phone: string;
}

export interface PlanSelection {
  plan_id: string;
  billing_period: "monthly" | "yearly";
}

export interface FormSession {
  id: string;
  current_step: number;
  personal_info?: PersonalInfo;
  plan_selection?: PlanSelection;
  addons?: string[];
  created_at: string;
  updated_at: string;
}

export const PLANS: Plan[] = [
  {
    id: "arcade",
    name: "Arcade",
    monthly_price: 9,
    yearly_price: 90,
  },
  {
    id: "advanced",
    name: "Advanced",
    monthly_price: 12,
    yearly_price: 120,
  },
  {
    id: "pro",
    name: "Pro",
    monthly_price: 15,
    yearly_price: 150,
  },
];

export const ADDONS: Addon[] = [
  {
    id: "online_services",
    name: "Online Services",
    monthly_price: 1,
    yearly_price: 10,
  },
  {
    id: "larger_storage",
    name: "Larger Storage",
    monthly_price: 2,
    yearly_price: 20,
  },
  {
    id: "customizable_profile",
    name: "Customizable Profile",
    monthly_price: 2,
    yearly_price: 20,
  },
];
