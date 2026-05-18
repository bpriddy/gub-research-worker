/**
 * prisma.ts — single Prisma client for the worker process.
 *
 * The worker is a short-lived Cloud Run Job: it boots, drains the queue,
 * and exits. A module-level singleton is fine; main.ts calls
 * `prisma.$disconnect()` before process exit so the pool drains cleanly.
 */
import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();
