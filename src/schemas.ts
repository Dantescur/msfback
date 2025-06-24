import { z } from "zod";
import sanitizeHtml from "sanitize-html";
import { PersonalInfo } from "./types";

const AddonIdEnum = z.enum([
  "customizable_profile",
  "larger_storage",
  "online_services",
]);

export const PersonalInfoSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  email: z
    .string()
    .email()
    .max(100)
    .regex(/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/),
  phone: z.string().transform((val) => val.replace(/[^\d+]/g, "")),
});

export const PlanSelectionSchema = z.object({
  plan_id: z.enum(["arcade", "advanced", "pro"]),
  billing_period: z.enum(["yearly", "monthly"]),
});

export const AddonsSchema = z.object({
  addons: z.array(AddonIdEnum),
});

export type AddonId = z.infer<typeof AddonIdEnum>;

export const NavigateSchema = z.object({
  step: z.number().min(1).max(4),
});

export const sanitizePersonalInfo = (info: PersonalInfo): PersonalInfo => ({
  ...info,
  name: sanitizeHtml(info.name, { allowedTags: [], allowedAttributes: {} }),
  email: info.email.trim().toLowerCase(),
});
