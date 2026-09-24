import { randomUUID } from 'node:crypto';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { DomainError, Errors } from './domain/errors';
import { PlanRegistry } from './domain/plans/PlanPolicy';
import type { Db } from './persistence/db';
import { Repositories } from './persistence/repositories';
import type { Clock, IdGenerator, Notifier, PaymentProvider } from './ports';
import { systemClock } from './ports';
import { BillingService } from './services/BillingService';
import type { BillingRules } from './services/PaymentOutcomeProcessor';
import { DEFAULT_BILLING_RULES, PaymentOutcomeProcessor } from './services/PaymentOutcomeProcessor';
import { SubscriptionService } from './services/SubscriptionService';
import { WebhookService } from './services/WebhookService';
import { SignatureVerifier } from './webhooks/SignatureVerifier';

export const randomIds: IdGenerator = {
  next: (prefix) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
};

/** Everything the service depends on. Tests inject doubles for provider, clock and notifier. */
export interface AppDependencies {
  db: Db;
  provider: PaymentProvider;
  webhookSecret: string;
  clock?: Clock;
  notifier?: Notifier;
  ids?: IdGenerator;
  plans?: PlanRegistry;
  billingRules?: BillingRules;
  /** Mounts POST /internal/billing/run. Never enabled in production. */
  enableInternalRoutes?: boolean;
}

export interface Container {
  repos: Repositories;
  plans: PlanRegistry;
  subscriptions: SubscriptionService;
  billing: BillingService;
  webhooks: WebhookService;
}

export function buildContainer(deps: AppDependencies): Container {
  const clock = deps.clock ?? systemClock;
  const notifier = deps.notifier ?? { notify: () => undefined };
  const ids = deps.ids ?? randomIds;
  const plans = deps.plans ?? new PlanRegistry();
  const repos = new Repositories(deps.db);
  const processor = new PaymentOutcomeProcessor(repos, plans, deps.billingRules ?? DEFAULT_BILLING_RULES);
  const billing = new BillingService(repos, plans, deps.provider, processor, clock, ids, notifier);
  const subscriptions = new SubscriptionService(repos, plans, billing, clock, ids, notifier);
  const webhooks = new WebhookService(repos, processor, new SignatureVerifier(deps.webhookSecret), clock, notifier);
  return { repos, plans, subscriptions, billing, webhooks };
}

type AsyncHandler = (req: Request, res: Response) => Promise<void> | void;
const route = (fn: AsyncHandler) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res)).catch(next);
};

export function createApp(deps: AppDependencies): { app: express.Express; container: Container } {
  const container = buildContainer(deps);
  const app = express();

  // Webhooks need the untouched raw body for signature verification, so they get their own parser.
  app.post(
    '/webhooks/payment-provider',
    express.raw({ type: () => true, limit: '100kb' }),
    route((req, res) => {
      const raw = Buffer.isBuffer(req.body) ? req.body : undefined;
      const result = container.webhooks.handle(raw, req.header('X-Provider-Signature'));
      res.status(200).json(result);
    }),
  );

  const api = express.Router();
  api.use(express.json({ limit: '100kb' }));

  api.post(
    '/subscriptions',
    route(async (req, res) => {
      const key = req.header('Idempotency-Key');
      if (key) {
        const result = await container.subscriptions.createIdempotent(req.body, key);
        if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
        res.status(result.status).json(result.body);
        return;
      }
      res.status(201).json(await container.subscriptions.create(req.body));
    }),
  );
  api.get('/subscriptions/:id', route((req, res) => void res.json(container.subscriptions.get(req.params.id))));
  api.post('/subscriptions/:id/cancel', route((req, res) => void res.json(container.subscriptions.cancel(req.params.id))));

  if (deps.enableInternalRoutes) {
    api.post('/internal/billing/run', route(async (_req, res) => void res.json({ results: await container.billing.runDue() })));
  }
  app.use(api);

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: { code: 'not_found', message: 'Route not found' } });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    let error = err;
    if ((err as { type?: string }).type === 'entity.parse.failed') error = Errors.validation(['body is not valid JSON']);
    if (error instanceof DomainError) {
      res.status(error.httpStatus).json({ error: { code: error.code, message: error.message, details: error.details } });
      return;
    }
    res.status(500).json({ error: { code: 'internal_error', message: (error as Error).message } });
  });

  return { app, container };
}
