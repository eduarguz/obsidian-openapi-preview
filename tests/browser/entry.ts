import { bundleOpenApi } from '../../src/bundle';
import { renderRedoc } from '../../src/renderer';
import { OpenApiView } from '../../src/view';
import { testApp } from './obsidian';
import OpenApiPlugin from '../../src/main';

Object.assign(window, { bundleOpenApi, renderRedoc, OpenApiView, OpenApiPlugin, testApp });
