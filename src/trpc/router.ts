import { router } from "./types";
import { userRouter } from "./routes/user";
import { propertyRouter } from "./routes/property";
import { jobsRouter } from "./routes/jobs";
import { subscriptionRouter } from "./routes/subscriptions";

export const appRouter = router({
  user: userRouter,
  property: propertyRouter,
  jobs: jobsRouter,
  subscription: subscriptionRouter,
});

export type AppRouter = typeof appRouter;
