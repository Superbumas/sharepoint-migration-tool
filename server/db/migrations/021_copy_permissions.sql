-- "Copy item permissions" job setting: { copy, includeGuests, userMap }.
-- Off (NULL) by default. When copy is on, a run re-applies the grants the
-- pre-flight recorded ("who had access") to the matching target items.
ALTER TABLE jobs ADD COLUMN permissions_json TEXT;