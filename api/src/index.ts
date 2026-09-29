import { app } from '@azure/functions';
import './functions/me';
import './functions/projects';
import './functions/pledges';
import './functions/my';
import './functions/stats';
import './functions/atlas';
import './functions/sitemap';

app.setup({ enableHttpStream: false });
