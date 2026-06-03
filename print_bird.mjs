import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Bird } from 'lucide-react';

console.log(renderToStaticMarkup(createElement(Bird)));
