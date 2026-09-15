// @ts-check
import { Command } from '../../command/command.mjs';
import { commandRouter } from '../../command/commandRouter.mjs';
import { securityFacade } from '../../security-authority/facade.mjs';

/**
 * Creates and routes a Command from an HTTP request.
 * @param {object} params
 * @param {import('express').Request} params.req
 * @param {import('express').Response} params.res
 * @param {import('../../command/command.mjs').CommandCategory} params.category
 * @param {string} params.type
 * @param {string | null} [params.target=null]
 * @param {Record<string, any>} [params.payload={}]
 * @param {string} [params.capability=null]
 * @param {Function} [params.onSuccess]
 */
export async function executeCommand({ req, res, category, type, target = null, payload = {}, capability = null, onSuccess = null }) {
  if (capability) {
    const authResult = securityFacade.authorize(capability);
    if (authResult.status !== 'OPERATIONAL') {
      return res.status(403).json({
        success: false,
        code: 'CAP_001',
        error: authResult.message || 'Action prohibited by Security Authority',
        protocolError: {
          code: 'CAP_001',
          domain: 'CAPABILITY',
          message: authResult.message || 'Action prohibited by Security Authority',
          retryable: false
        }
      });
    }
  }

  const command = new Command({
    category,
    type,
    target,
    payload,
    source: 'UI_OPERATOR',
    traceId: req.traceId
  });

  try {
    const routeResult = await commandRouter.route(command, req.headers);
    if (!routeResult.success) {
      return res.status(400).json({
        success: false,
        error: 'Command could not be routed or handled'
      });
    }

    if (onSuccess) {
      return await onSuccess(routeResult.results[0] || null);
    }

    return res.status(200).json({
      success: true,
      commandId: command.id,
      data: routeResult.results[0] || null
    });
  } catch (err) {
    const statusCode = err.code === 'LF-701' ? 400 : (err.status || 500);
    return res.status(statusCode).json({
      success: false,
      code: err.code || 'INTERNAL_FAULT',
      error: err.message,
      details: err.details || null
    });
  }
}
