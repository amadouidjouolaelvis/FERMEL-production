// À intégrer dans le frontend une fois le projet Supabase créé.
// La clé publishable/anon peut être côté navigateur.
// NE JAMAIS mettre la service_role key ici.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const supabase = createClient(
  'https://YOUR_PROJECT.supabase.co',
  'YOUR_SUPABASE_PUBLISHABLE_KEY'
);
