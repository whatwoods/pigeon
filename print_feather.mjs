import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Feather } from 'lucide-react';

console.log(renderToStaticMarkup(createElement(Feather)));
