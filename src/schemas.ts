import { z } from 'zod';
import { Park4nightError } from './errors.ts';

export const positiveIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const folderIdSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const usernameSchema = z.string().trim().min(1).max(320);
const codes = z.array(z.string().regex(/^[A-Za-z0-9_]+$/)).max(100);
const numericString = z.string().regex(/^\d+(?:\.\d+)?$/);
export const searchFilterSchema = z.strictObject({
  type: codes.optional(),
  custom_type: codes.optional(),
  services: codes.optional(),
  activities: codes.optional(),
  rating: numericString.refine(value => Number(value) <= 5).optional(),
  maxHeight: numericString.refine(value => Number.isFinite(Number(value)) && Number(value) > 0).optional(),
  all_year: z.enum(['0', '1']).optional(),
  booking_filter: z.enum(['0', '1']).optional()
});
export const searchOptionsSchema = z.strictObject({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  maxDistanceKm: z.number().positive().optional(),
  filter: searchFilterSchema.optional()
});
export const loginSchema = z.strictObject({ username: usernameSchema, password: z.string().trim().min(1) });
export const folderFieldsSchema = z.object({ name: z.string().trim().min(1).max(500), icon: z.string().trim().min(1).max(100) });
export const folderUpdateSchema = folderFieldsSchema.extend({ id: positiveIdSchema });
export const placeKindSchema = z.enum(['created', 'visited', 'commented']);
export const filterKindSchema = z.enum(['type', 'custom_type', 'services', 'activities']);
export const publicPlacesSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('created'), username: usernameSchema }),
  z.strictObject({ kind: z.literal('visited'), username: usernameSchema }),
  z.strictObject({ kind: z.literal('commented'), userId: positiveIdSchema })
]);
export type SearchFilter = z.infer<typeof searchFilterSchema>;
export type SearchOptions = z.infer<typeof searchOptionsSchema>;
export type PublicPlacesOptions = z.infer<typeof publicPlacesSchema>;

export function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Park4nightError('INVALID_INPUT', 'Invalid input. Check the method parameters and value types.');
  return result.data;
}
