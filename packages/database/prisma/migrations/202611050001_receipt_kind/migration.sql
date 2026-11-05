-- Commit the enum value before the next migration uses it in a CHECK expression.
ALTER TYPE "MovementKind" ADD VALUE 'RECEIPT';
