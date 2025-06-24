import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { nanoid } from "nanoid";
import {
  ADDONS,
  PLANS,
  FormSession,
  PersonalInfo,
  PlanSelection,
} from "./types";
import {
  AddonId,
  AddonsSchema,
  NavigateSchema,
  PersonalInfoSchema,
  PlanSelectionSchema,
  sanitizePersonalInfo,
} from "./schemas";
import { showRoutes } from "hono/dev";
import { prettyJSON } from "hono/pretty-json";

type Bindings = {
  FORM_SESSION: KVNamespace;
};

const app = new Hono<{ Bindings: Bindings }>();

const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 100;
const SESSION_TTL = 60 * 60 * 24;

//  Utility functions
const errorResponse = (message: string, details: string) => ({
  error: message,
  details,
  timestamp: new Date().toISOString(),
});

const isFormSession = (data: any): data is FormSession => {
  return (
    data &&
    typeof data.id == "string" &&
    typeof data.current_step == "number" &&
    data.current_step >= 1 &&
    data.current_step <= 4
  );
};

// Retry wrapper
const withRetry = async <T>(
  operation: () => Promise<T>,
  maxRetries: number = MAX_RETRIES,
  initialDelayMs: number = INITIAL_RETRY_DELAY_MS,
): Promise<T> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries - 1) {
        const delay = initialDelayMs * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
};

// Middlewares
app.use(prettyJSON());
app.use("*", async (c, next) => {
  try {
    await next();
  } catch (error) {
    console.error("Error:", error);
    return c.json(
      errorResponse(
        "Internal Server Error",
        error instanceof Error ? error.message : "Unknown error",
      ),
      500,
    );
  }
});

// KV operations
const getSession = async (
  kv: KVNamespace,
  sessionId: string,
): Promise<FormSession | null> => {
  return withRetry(
    async () => {
      try {
        const sessionData = await kv.get<FormSession>(
          `session:${sessionId}`,
          "json",
        );
        if (!sessionData) return null;

        if (!isFormSession(sessionData)) {
          console.error("Invalid session data - resetting");
          await kv.delete(`session:${sessionId}`);
          return null;
        }

        return sessionData;
      } catch (error) {
        console.error("KV get error:", error);
        throw new Error("Failed to access session data");
      }
    },
    3,
    200,
  ); // 3 retries with exponential backoff starting at 200ms
};

const updateSession = async (
  kv: KVNamespace | undefined,
  sessionId: string,
  updates: Partial<FormSession>,
): Promise<FormSession> => {
  if (!kv) {
    throw new Error("KV namespace not available");
  }

  return withRetry(async () => {
    const existing = await getSession(kv, sessionId);
    const now = new Date().toISOString();

    const updatedSession: FormSession = {
      id: sessionId,
      current_step: 1,
      created_at: now,
      updated_at: now,
      ...existing,
      ...updates,
    };

    if (updatedSession.current_step < 1 || updatedSession.current_step > 4) {
      throw new Error(`Invalid step value: ${updatedSession.current_step}`);
    }

    await kv.put(`session:${sessionId}`, JSON.stringify(updatedSession), {
      expirationTtl: SESSION_TTL,
    });

    return updatedSession;
  });
};

// Routes
app.post("/init", async (c) => {
  if (!c.env.FORM_SESSION) {
    return c.json(
      errorResponse("Configuration error", "KV namespace binding not found."),
      500,
    );
  }

  try {
    const sessionId = nanoid();
    const now = new Date().toISOString();

    const newSession: FormSession = {
      id: sessionId,
      current_step: 1,
      created_at: now,
      updated_at: now,
    };

    await c.env.FORM_SESSION.put(
      `session:${sessionId}`,
      JSON.stringify(newSession),
      { expirationTtl: 60 * 60 * 24 },
    );
    return c.json({
      session_id: sessionId,
      available_plans: PLANS,
      available_addons: ADDONS,
    });
  } catch (error) {
    return c.json(
      errorResponse(
        "Initialization failed",
        error instanceof Error ? error.message : String(error),
      ),
      500,
    );
  }
});

app.get("/health", (c) => c.json({ status: "ok" }));

app.put(
  "/:sessionId/personal",
  zValidator("json", PersonalInfoSchema),
  async (c) => {
    const { sessionId } = c.req.param();
    const personalInfo = sanitizePersonalInfo(c.req.valid("json"));

    try {
      const updatedSession = await updateSession(
        c.env.FORM_SESSION,
        sessionId,
        {
          personal_info: personalInfo as PersonalInfo,
          current_step: 2,
        },
      );

      return c.json({
        status: "success",
        current_step: updatedSession.current_step,
        next_step: updatedSession.current_step + 1,
      });
    } catch (error) {
      return c.json(
        errorResponse(
          "Failed to save personal info",
          error instanceof Error ? error.message : String(error),
        ),
        500,
      );
    }
  },
);

app.put(
  "/:sessionId/plan",
  zValidator("json", PlanSelectionSchema),
  async (c) => {
    const { sessionId } = c.req.param();

    try {
      const planSelection = c.req.valid("json");
      const selectedPlan = PLANS.find((p) => p.id === planSelection.plan_id);

      if (!selectedPlan) {
        return c.json(
          errorResponse(
            "Invalid plan selected",
            "The specified plan does not exist",
          ),
          400,
        );
      }

      const updatedSession = await updateSession(
        c.env.FORM_SESSION,
        sessionId,
        {
          plan_selection: planSelection as PlanSelection,
          current_step: 3,
        },
      );

      return c.json({
        status: "success",
        current_step: updatedSession.current_step,
        next_step: updatedSession.current_step + 1,
        selected_plan: {
          id: selectedPlan.id,
          name: selectedPlan.name,
          price:
            planSelection.billing_period === "monthly"
              ? selectedPlan.monthly_price
              : selectedPlan.yearly_price,
          billing_period: planSelection.billing_period,
        },
      });
    } catch (error) {
      return c.json(
        errorResponse(
          "Failed to save plan selection",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  },
);

app.put("/:sessionId/addons", zValidator("json", AddonsSchema), async (c) => {
  const { sessionId } = c.req.param();

  try {
    const { addons } = c.req.valid("json") as { addons: AddonId[] };
    const updatedSession = await updateSession(c.env.FORM_SESSION, sessionId, {
      addons,
      current_step: 4,
    });

    const selectedAddons = ADDONS.filter((addon) =>
      addons.includes(addon.id),
    ).map((addon) => ({
      id: addon.id,
      name: addon.name,
      price:
        updatedSession.plan_selection?.billing_period === "monthly"
          ? addon.monthly_price
          : addon.yearly_price,
    }));

    return c.json({
      status: "success",
      current_step: 3,
      next_step: 4,
      selected_addons: selectedAddons,
    });
  } catch (error) {
    return c.json(
      errorResponse(
        "Failed to save addons",
        error instanceof Error ? error.message : String(error),
      ),
      500,
    );
  }
});

app.post("/:sessionId/submit", async (c) => {
  const { sessionId } = c.req.param();

  try {
    const session = await getSession(c.env.FORM_SESSION, sessionId);
    if (!session) {
      return c.json(
        errorResponse("Session not found", "No session with this ID exists"),
        404,
      );
    }

    if (session.current_step !== 4) {
      return c.json(
        errorResponse(
          "Invalid submission",
          `Submission requires completion of all steps (current step: ${session.current_step})`,
        ),
        400,
      );
    }

    if (!session.personal_info || !session.plan_selection) {
      return c.json(
        errorResponse(
          "Incomplete data",
          "Personal info and plan selection are required",
        ),
        400,
      );
    }

    const selectedPlan = PLANS.find(
      (p) => p.id === session.plan_selection!.plan_id,
    );
    if (!selectedPlan) {
      return c.json(
        errorResponse("Invalid plan", "The selected plan no longer exists"),
        400,
      );
    }

    const planPrice =
      session.plan_selection.billing_period === "monthly"
        ? selectedPlan.monthly_price
        : selectedPlan.yearly_price;

    const selectedAddons = (session.addons || [])
      .map((addonId) => {
        const addon = ADDONS.find((a) => a.id === addonId);
        return addon
          ? {
              id: addon.id,
              name: addon.name,
              price:
                session.plan_selection?.billing_period === "monthly"
                  ? addon.monthly_price
                  : addon.yearly_price,
            }
          : null;
      })
      .filter(Boolean);

    const addonsTotal = selectedAddons.reduce(
      (sum, addon) => sum + (addon?.price || 0),
      0,
    );
    const total = parseFloat((planPrice + addonsTotal).toFixed(2));

    const confirmationId = `conf-${nanoid(6)}`;

    await updateSession(c.env.FORM_SESSION, sessionId, {
      current_step: 4,
    });

    return c.json({
      status: "success",
      confirmation_id: confirmationId,
      summary: {
        personal_info: session.personal_info,
        plan: {
          name: selectedPlan.name,
          price: planPrice,
          billing_period: session.plan_selection.billing_period,
        },
        addons: selectedAddons,
        total,
      },
    });
  } catch (error) {
    return c.json(
      errorResponse(
        "Submission failed",
        error instanceof Error ? error.message : String(error),
      ),
      500,
    );
  }
});

app.get("/:sessionId", async (c) => {
  const { sessionId } = c.req.param();

  try {
    const session = await getSession(c.env.FORM_SESSION, sessionId);

    if (!session) {
      return c.json(
        errorResponse("Session not found", "What are you doing?"),
        404,
      );
    }

    return c.json({
      current_step: session.current_step,
      personal_info: session.personal_info,
      selected_plan: session.plan_selection
        ? {
            id: session.plan_selection.plan_id,
            name: PLANS.find((p) => p.id === session.plan_selection?.plan_id)
              ?.name,
            price:
              session.plan_selection.billing_period === "monthly"
                ? PLANS.find((p) => p.id === session.plan_selection?.plan_id)
                    ?.monthly_price
                : PLANS.find((p) => p.id === session.plan_selection?.plan_id)
                    ?.yearly_price,
            billing_period: session.plan_selection.billing_period,
          }
        : undefined,
      selected_addons: session.addons
        ?.map((addonId) => {
          const addon = ADDONS.find((a) => a.id === addonId);
          return addon
            ? {
                id: addon.id,
                name: addon.name,
                price:
                  session.plan_selection?.billing_period === "monthly"
                    ? addon.monthly_price
                    : addon.yearly_price,
              }
            : undefined;
        })
        .filter(Boolean),
    });
  } catch (error) {
    return c.json(
      errorResponse(
        "Failed to submit data",
        error instanceof Error ? error.message : String(error),
      ),
      500,
    );
  }
});

// Navigate to specific step
app.post(
  "/:sessionId/navigate",
  zValidator("json", NavigateSchema),
  async (c) => {
    const { sessionId } = c.req.param();
    const { step } = c.req.valid("json");

    try {
      const session = await getSession(c.env.FORM_SESSION, sessionId);
      if (!session) {
        return c.json(errorResponse("Session not found", "?"), 404);
      }

      // Don't allow jumping ahead
      if (step > session.current_step) {
        return c.json(
          errorResponse(
            "Cannot skip ahead",
            "Only after alr going through all steps.",
          ),
          400,
        );
      }

      await updateSession(c.env.FORM_SESSION, sessionId, {
        current_step: step,
      });

      return c.json({
        status: "success",
        current_step: step,
      });
    } catch (error) {
      return c.json(
        errorResponse(
          "Failed to navigate to step",
          error instanceof Error ? error.message : String(error),
        ),
        500,
      );
    }
  },
);

app.delete("/:sessionId", async (c) => {
  const { sessionId } = c.req.param();

  try {
    const session = await getSession(c.env.FORM_SESSION, sessionId);

    if (!session) {
      return c.json(
        errorResponse("Session not found", "No session with this ID"),
        404,
      );
    }

    await c.env.FORM_SESSION.delete(`session:${sessionId}`);
    return c.json({ status: "success", message: "Session deleted" });
  } catch (error) {
    return c.json(
      errorResponse(
        "Failed to delete session",
        error instanceof Error ? error.message : String(error),
      ),
      500,
    );
  }
});

showRoutes(app, {
  verbose: true,
});

export default app;
