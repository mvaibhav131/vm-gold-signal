import { TRADED_SYMBOL } from '@vmgs/core';
import { z } from 'zod';

export const symbolSchema = z.literal(TRADED_SYMBOL);

export const priceSchema = z.number().positive();
