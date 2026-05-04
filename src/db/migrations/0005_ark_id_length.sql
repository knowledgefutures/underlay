-- Clear stale 8-char ARK IDs; new 10-char+check IDs are generated when ARK is re-enabled per collection.
DELETE FROM ark_collections;
