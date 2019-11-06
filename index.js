/**
 * The MIT License (MIT)
 *
 * Copyright (c) 2016 @biddster
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
module.exports = function(RED) {
    const moment = require('moment');
    const SunCalc = require('suncalc');
    const _ = require('lodash');
    const fmt = 'YYYY-MM-DD HH:mm';

    const Status = Object.freeze({
        SCHEDULED: Symbol('scheduled'),
        SUSPENDED: Symbol('suspended'),
        FIRED: Symbol('fired'),
        ERROR: Symbol('error')
    });

    const weekdays = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);

    function toBoolean(val) {
        // eslint-disable-next-line prefer-template
        return (val + '').toLowerCase() === 'true';
    }

    const configuration = Object.freeze({
        ontime: String,
        ontopic: String,
        onpayload: String,
        onoffset: Number,
        onrandomoffset: toBoolean,
        offtime: String,
        offtopic: String,
        offpayload: String,
        offoffset: Number,
        offrandomoffset: toBoolean,
        mon: toBoolean,
        tue: toBoolean,
        wed: toBoolean,
        thu: toBoolean,
        fri: toBoolean,
        sat: toBoolean,
        sun: toBoolean,
        lon: Number,
        lat: Number,
        suspended: toBoolean
    });

    RED.nodes.registerType('schedex', function(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const events = {};
        // Assume the node is off initially
        let lastEvent = events.off;

        // Make sure these two props are proper booleans.
        config.onrandomoffset = !!config.onrandomoffset;
        config.offrandomoffset = !!config.offrandomoffset;
        // Any old versions upgraded will be undefined so convert them to boolean
        // eslint-disable-next-line no-return-assign
        weekdays.forEach(weekday => (config[weekday] = !!config[weekday]));

        function inverse(event) {
            return event === events.on ? events.off : events.on;
        }

        function getWeekdayConfig() {
            return weekdays.map(weekday => config[weekday]);
        }

        function isSuspended() {
            return (
                config.suspended ||
                getWeekdayConfig().indexOf(true) === -1 ||
                (!events.on.time && !events.off.time)
            );
        }

        function setStatus(status, { event = null, manual = false, error = null } = {}) {
            const message = [];
            let shape = 'dot';
            let fill = 'red';
            if (status === Status.SCHEDULED) {
                fill = 'yellow';
                if (events.on.moment && events.off.moment) {
                    const firstEvent = events.on.moment.isBefore(events.off.moment)
                        ? events.on
                        : events.off;
                    message.push(firstEvent.name);
                    message.push(firstEvent.moment.format(fmt));
                    message.push(inverse(firstEvent).name);
                    message.push(inverse(firstEvent).moment.format(fmt));
                } else if (events.on.moment) {
                    message.push(events.on.name);
                    message.push(events.on.moment.format(fmt));
                } else if (events.off.moment) {
                    message.push(events.off.name);
                    message.push(events.off.moment.format(fmt));
                }
            } else if (status === Status.FIRED) {
                // eslint-disable-next-line prefer-destructuring
                shape = event.shape;
                fill = manual ? 'blue' : 'green';
                message.push(event.name);
                message.push(manual ? 'manual' : 'auto');
                if (isSuspended()) {
                    message.push('- scheduling suspended');
                } else if (inverse(event).moment) {
                    message.push(
                        `until ${inverse(event).name} at ${inverse(event).moment.format(fmt)}`
                    );
                } else {
                    const next = inverse(event).moment ? inverse(event) : event;
                    if (next.moment) {
                        message.push(`until ${next.name} at ${next.moment.format(fmt)}`);
                    }
                }
            } else if (status === Status.SUSPENDED) {
                fill = 'grey';
                message.push('Scheduling suspended');
                if (getWeekdayConfig().indexOf(true) === -1) {
                    message.push('(no weekdays selected)');
                } else if (!events.on.time && !events.off.time) {
                    message.push('(no on or off time)');
                }
                message.push('- manual mode only');
            } else if (status === Status.ERROR) {
                message.push(error);
            }
            setTimeout(() => {
                node.status({ fill, shape, text: message.join(' ') });
            }, 1);
        }

        function send(event, manual) {
            lastEvent = event;
            node.send({ topic: event.topic, payload: event.payload });
            setStatus(Status.FIRED, { event, manual });
        }

        function teardownEvent(event) {
            if (event) {
                if (event.timeout) {
                    clearTimeout(event.timeout);
                }
                event.moment = null;
            }
        }

        function schedule(event, isInitial) {
            teardownEvent(event);

            if (!event.time) {
                return true;
            }

            const now = node.now();
            const matches = new RegExp('(\\d+):(\\d+)', 'u').exec(event.time);
            if (matches && matches.length) {
                // Don't use existing 'now' moment here as hour and minute mutate the moment.
                event.moment = node
                    .now()
                    .hour(+matches[1])
                    .minute(+matches[2]);
            } else {
                const sunCalcTimes = SunCalc.getTimes(new Date(), config.lat, config.lon);
                const date = sunCalcTimes[event.time];
                if (date) {
                    event.moment = moment(date);
                }
            }
            if (!event.moment) {
                setStatus(Status.ERROR, { error: `Invalid time [${event.time}]` });
                return false;
            }
            event.moment.seconds(0).millisecond(0);

            if (event.offset) {
                let adjustment = event.offset;
                if (event.randomoffset) {
                    adjustment = event.offset * Math.random();
                }
                event.moment.add(adjustment, 'minutes');
            }

            if (!isInitial || (isInitial && now.isAfter(event.moment))) {
                event.moment.add(1, 'day');
            }

            // Adjust weekday if not selected
            const weekdayConfig = getWeekdayConfig();
            while (!weekdayConfig[event.moment.isoWeekday() - 1]) {
                event.moment.add(1, 'day');
            }

            const delay = event.moment.diff(now);
            event.timeout = setTimeout(event.callback, delay);
            return true;
        }

        /**
         * @param {string} eventName
         * @param {string} shape
         * @returns
         */
        function setupEvent(eventName, shape) {
            const filtered = _.pickBy(config, function(value, key) {
                return key && key.indexOf(eventName) === 0;
            });
            const event = _.mapKeys(filtered, function(value, key) {
                return key.substring(eventName.length).toLowerCase();
            });
            event.name = eventName.toUpperCase();
            event.shape = shape;
            event.callback = function() {
                send(event);
                schedule(event);
            };
            return event;
        }

        function teardownEvents() {
            teardownEvent(events.on);
            teardownEvent(events.off);
        }

        function suspend() {
            teardownEvents();
            setStatus(Status.SUSPENDED);
        }

        function resume() {
            if (schedule(events.on, true) && schedule(events.off, true)) {
                setStatus(Status.SCHEDULED);
            }
        }

        function bootstrap() {
            teardownEvents();
            events.on = setupEvent('on', 'dot');
            events.off = setupEvent('off', 'ring');
            if (isSuspended()) {
                suspend();
            } else {
                resume();
            }
        }

        function enumerateProgrammables(callback) {
            _.forIn(configuration, (typeFunc, name) => callback(config, name, typeFunc));
        }

        node.on('input', function(msg) {
            let requiresBootstrap = false;
            let handled = false;
            if (_.isString(msg.payload)) {
                // TODO - with these payload options, we can't support on and ontime etc.
                if (msg.payload === 'on') {
                    handled = true;
                    send(events.on, true);
                } else if (msg.payload === 'off') {
                    handled = true;
                    send(events.off, true);
                } else if (msg.payload === 'toggle') {
                    handled = true;
                    send(inverse(lastEvent), true);
                } else if (msg.payload === 'info' || msg.payload === 'info_local') {
                    handled = true;
                    const payload = _.pick(config, Object.keys(configuration));
                    payload.name = config.name;
                    if (isSuspended()) {
                        payload.state = 'suspended';
                        payload.on = 'suspended';
                        payload.off = 'suspended';
                    } else {
                        payload.state = events.off.moment.isAfter(events.on.moment)
                            ? 'off'
                            : 'on';
                        if (msg.payload === 'info') {
                            payload.on = events.on.moment.toDate().toUTCString();
                            payload.off = events.off.moment.toDate().toUTCString();
                        } else if (msg.payload === 'info_local') {
                            payload.on = events.on.moment.toISOString(true);
                            payload.off = events.off.moment.toISOString(true);
                        }
                    }
                    node.send({ topic: 'info', payload });
                } else {
                    enumerateProgrammables(function(cfg, prop, typeConverter) {
                        const match = new RegExp(`.*${prop}\\s+(\\S+)`, 'u').exec(msg.payload);
                        if (match) {
                            handled = true;
                            const previous = cfg[prop];
                            cfg[prop] = typeConverter(match[1]);
                            requiresBootstrap = requiresBootstrap || previous !== cfg[prop];
                        }
                    });
                }
            } else {
                enumerateProgrammables(function(cfg, prop, typeConverter) {
                    if (Object.prototype.hasOwnProperty.call(msg.payload, prop)) {
                        handled = true;
                        const previous = cfg[prop];
                        cfg[prop] = typeConverter(msg.payload[prop]);
                        requiresBootstrap = requiresBootstrap || previous !== cfg[prop];
                    }
                });
            }
            if (!handled) {
                setStatus(Status.ERROR, { error: 'Unsupported input' });
            } else if (requiresBootstrap) {
                bootstrap();
            }
        });

        node.on('close', teardownEvents);

        // Bodges to allow testing
        node.schedexEvents = () => events;
        node.schedexConfig = () => config;
        node.now = () => moment();

        bootstrap();
    });
};
