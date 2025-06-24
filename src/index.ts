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
  PersonalInfoSchema,
  PlanSelectionSchema,
  sanitizePersonalInfo,
  sessionIdSchema,
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
  const baseCheck =
    data &&
    typeof data.id === "string" &&
    typeof data.current_step === "number" &&
    data.current_step >= 1 &&
    data.current_step <= 4;
  if (!baseCheck) return false;
  if (
    data.personal_info &&
    !PersonalInfoSchema.safeParse(data.personal_info).success
  )
    return false;
  if (
    data.plan_selection &&
    !PlanSelectionSchema.safeParse(data.plan_selection).success
  )
    return false;
  if (data.addons && !AddonsSchema.safeParse({ addons: data.addons }).success)
    return false;
  return true;
};

// Retry wrapper
const withRetry = async <T>(
  operation: () => Promise<T>,
  maxRetries: number,
  initialDelayMs: number,
) => {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (error instanceof Error && error.message.includes("permission"))
        throw error; // Fail fast
      if (attempt < maxRetries - 1)
        await new Promise((r) =>
          setTimeout(r, initialDelayMs * Math.pow(2, attempt)),
        );
    }
  }
  throw lastError;
};

// const getHATEOASLinks = (
//   sessionId: string,
//   session: FormSession,
// ): Record<string, { href: string; method: string }> => {
//   const baseUrl = `/${sessionId}`;
//   const links: Record<string, { href: string; method: string }> = {
//     self: { href: baseUrl, method: "GET" },
//     delete: { href: baseUrl, method: "DELETE" },
//   };
//
//   links.personal = { href: `${baseUrl}/personal`, method: "PUT" };
//   links.plan = { href: `${baseUrl}/plan`, method: "PUT" };
//   links.addons = { href: `${baseUrl}/addons`, method: "PUT" };
//   if (
//     session.personal_info &&
//     PersonalInfoSchema.safeParse(session.personal_info).success &&
//     session.plan_selection &&
//     PlanSelectionSchema.safeParse(session.plan_selection).success &&
//     session.addons &&
//     AddonsSchema.safeParse({ addons: session.addons }).success
//   ) {
//     links.submit = { href: `${baseUrl}/submit`, method: "POST" };
//   }
//   return links;
// };

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
  if (!kv) throw new Error("KV namespace not available");

  return withRetry(
    async () => {
      const existing = await getSession(kv, sessionId);

      if (!existing) {
        throw new Error("Session does not exist for update.");
      }

      const now = new Date().toISOString();

      const updatedSession: FormSession = {
        ...existing,
        ...updates,
        id: existing.id,
        created_at: now,
        updated_at: now,
      };

      let newStep = existing.current_step;
      if (
        updatedSession.personal_info &&
        PersonalInfoSchema.safeParse(updatedSession.personal_info).success
      ) {
        newStep = Math.max(newStep, 2);
      }
      if (
        updatedSession.plan_selection &&
        PlanSelectionSchema.safeParse(updatedSession.plan_selection).success
      ) {
        newStep = Math.max(newStep, 3);
      }
      if (
        updatedSession.addons &&
        AddonsSchema.safeParse({ addons: updatedSession.addons }).success
      ) {
        newStep = Math.max(newStep, 4);
      }
      updatedSession.current_step = newStep;
      if (updatedSession.current_step < 1 || updatedSession.current_step > 4) {
        throw new Error(`Invalid step value: ${updatedSession.current_step}`);
      }
      await kv.put(`session:${sessionId}`, JSON.stringify(updatedSession), {
        expirationTtl: SESSION_TTL,
      });
      return updatedSession;
    },
    MAX_RETRIES,
    INITIAL_RETRY_DELAY_MS,
  );
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

    const parsedSessionId = sessionIdSchema.safeParse({ sessionId });

    if (!parsedSessionId.success) {
      return c.json(
        errorResponse(
          "Invalid session ID format",
          parsedSessionId.error.errors[0].message,
        ),
        400,
      );
    }

    const validatedSessionId = parsedSessionId.data.sessionId;

    const personalInfo = sanitizePersonalInfo(c.req.valid("json"));

    try {
      const updatedSession = await updateSession(
        c.env.FORM_SESSION,
        validatedSessionId,
        {
          personal_info: personalInfo as PersonalInfo,
        },
      );

      return c.json({
        status: "success",
        current_step: updatedSession.current_step,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "Session does not exist for update."
      ) {
        return c.json(
          errorResponse(
            "Session Not Found",
            "The provided session ID does not exist or has expired.",
          ),
          404,
        );
      }
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

    const parsedSessionId = sessionIdSchema.safeParse({ sessionId });

    if (!parsedSessionId.success) {
      return c.json(
        errorResponse(
          "Invalid session ID format",
          parsedSessionId.error.errors[0].message,
        ),
        400,
      );
    }

    const validatedSessionId = parsedSessionId.data.sessionId;

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
        validatedSessionId,
        {
          plan_selection: planSelection as PlanSelection,
        },
      );

      return c.json({
        status: "success",
        current_step: updatedSession.current_step,
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
      if (
        error instanceof Error &&
        error.message === "Session does not exist for update."
      ) {
        return c.json(
          errorResponse(
            "Session Not Found",
            "The provided session ID does not exist or has expired.",
          ),
          404,
        );
      }
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

  const parsedSessionId = sessionIdSchema.safeParse({ sessionId });

  if (!parsedSessionId.success) {
    return c.json(
      errorResponse(
        "Invalid session ID format",
        parsedSessionId.error.errors[0].message,
      ),
      400,
    );
  }

  const validatedSessionId = parsedSessionId.data.sessionId;

  try {
    const { addons } = c.req.valid("json") as { addons: AddonId[] };
    const updatedSession = await updateSession(
      c.env.FORM_SESSION,
      validatedSessionId,
      {
        addons,
      },
    );

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
      current_step: updatedSession.current_step,
      selected_addons: selectedAddons,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Session does not exist for update."
    ) {
      return c.json(
        errorResponse(
          "Session Not Found",
          "The provided session ID does not exist or has expired.",
        ),
        404,
      );
    }
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

  const parsedSessionId = sessionIdSchema.safeParse({ sessionId });

  if (!parsedSessionId.success) {
    return c.json(
      errorResponse(
        "Invalid session ID format",
        parsedSessionId.error.errors[0].message,
      ),
      400,
    );
  }

  const validatedSessionId = parsedSessionId.data.sessionId;

  try {
    const session = await getSession(c.env.FORM_SESSION, validatedSessionId);
    if (!session) {
      return c.json(
        errorResponse("Session not found", "No session with this ID exists"),
        404,
      );
    }

    const errors: string[] = [];
    if (
      !session.personal_info ||
      !PersonalInfoSchema.safeParse(session.personal_info).success
    ) {
      errors.push("Valid personal info is required");
    }
    if (
      !session.plan_selection ||
      !PlanSelectionSchema.safeParse(session.plan_selection).success
    ) {
      errors.push("Valid plan selection is required");
    }
    if (
      !session.addons ||
      !AddonsSchema.safeParse({ addons: session.addons }).success
    ) {
      errors.push("Valid add-ons selection is required");
    }
    if (errors.length > 0) {
      return c.json(errorResponse("Incomplete data", errors.join("; ")), 400);
    }

    if (
      !PersonalInfoSchema.safeParse(session.personal_info).success ||
      !PlanSelectionSchema.safeParse(session.plan_selection).success
    ) {
      return c.json(
        errorResponse("Invalid data", "Incomplete or invalid session data"),
        400,
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
    if (
      error instanceof Error &&
      error.message === "Session does not exist for update."
    ) {
      return c.json(
        errorResponse(
          "Session Not Found",
          "The provided session ID does not exist or has expired.",
        ),
        404,
      );
    }
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

  const parsedSessionId = sessionIdSchema.safeParse({ sessionId });

  if (!parsedSessionId.success) {
    return c.json(
      errorResponse(
        "Invalid session ID format",
        parsedSessionId.error.errors[0].message,
      ),
      400,
    );
  }

  const validatedSessionId = parsedSessionId.data.sessionId;

  try {
    const session = await getSession(c.env.FORM_SESSION, validatedSessionId);

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
    if (
      error instanceof Error &&
      error.message === "Session does not exist for update."
    ) {
      return c.json(
        errorResponse(
          "Session Not Found",
          "The provided session ID does not exist or has expired.",
        ),
        404,
      );
    }
    return c.json(
      errorResponse(
        "Failed to submit data",
        error instanceof Error ? error.message : String(error),
      ),
      500,
    );
  }
});

app.delete("/:sessionId", async (c) => {
  const { sessionId } = c.req.param();

  const parsedSessionId = sessionIdSchema.safeParse({ sessionId });

  if (!parsedSessionId.success) {
    return c.json(
      errorResponse(
        "Invalid session ID format",
        parsedSessionId.error.errors[0].message,
      ),
      400,
    );
  }

  const validatedSessionId = parsedSessionId.data.sessionId;

  try {
    const session = await getSession(c.env.FORM_SESSION, validatedSessionId);

    if (!session) {
      return c.json(
        errorResponse("Session not found", "No session with this ID"),
        404,
      );
    }

    await c.env.FORM_SESSION.delete(`session:${validatedSessionId}`);
    return c.json({ status: "success", message: "Session deleted" });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Session does not exist for update."
    ) {
      return c.json(
        errorResponse(
          "Session Not Found",
          "The provided session ID does not exist or has expired.",
        ),
        404,
      );
    }
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
