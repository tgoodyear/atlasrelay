import { app } from '@azure/functions';
import './functions/me';
import './functions/projects';
import './functions/pledges';
import './functions/my';
import './functions/stats';
import './functions/atlas';

app.setup({ enableHttpStream: false });
