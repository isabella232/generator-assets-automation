/*
 * Copyright (c) 2014 Adobe Systems Incorporated. All rights reserved.
 *  
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"), 
 * to deal in the Software without restriction, including without limitation 
 * the rights to use, copy, modify, merge, publish, distribute, sublicense, 
 * and/or sell copies of the Software, and to permit persons to whom the 
 * Software is furnished to do so, subject to the following conditions:
 *  
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *  
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, 
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER 
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING 
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER 
 * DEALINGS IN THE SOFTWARE.
 * 
 */

(function () {
    "use strict";

    var TEST_PATH_ROOT = "test/",
        OUTPUT_FOLDER_SUFFIX = "-assets",
        DISABLED_TEST_FOLDER_SUFFIX = "-disabled",
        MENU_ID = "generator-assets-automation",
        ASSETS_PLUGIN_ID = "generator-assets",
        CREMA_PLUGIN_ID = "crema",
        ASSETS_PLUGIN_CHECK_INTERVAL = 1000, // one second
        FILES_TO_IGNORE = new RegExp("(.DS_Store)$|(desktop.ini)$", "i"),
        ERRORS_TXT = "errors.txt",
        MAX_CONCURRENT_COMPARE_JOBS = 10,
        GENERATOR_CONFIG_FILE = "generator.json",
        CREMA_ASSSET_DIR = "crema-assets",
        DEFAULT_MAX_COMPARE_METRIC = 10;

    var path = require("path"),
        childProcess = require("child_process"),
        Q = require("q"),
        tmp = require("tmp"),
        fse = require("fs-extra"),
        CremaTester = require("./lib/crema-tester");

    // clean up temp files even if there's an uncaught exception
    tmp.setGracefulCleanup(true);

    var _generator,
        _config,
        _logger,
        _assetsPluginDeferred = Q.defer(),
        _assetsPluginPromise = _assetsPluginDeferred.promise.timeout(10000),
        _cremaTesterDeferred = Q.defer(),
        _cremaTesterPromise = _cremaTesterDeferred.promise.timeout(10000),
        _isCremaPluginLoaded = false,
        _psExecutablePathPromise = null,
        _idleDeferred = null,
        _activeDeferred = Q.defer();

    function getAssetsPlugin() {
        return _assetsPluginPromise;
    }

    function getCremaTester() {
        return _cremaTesterPromise;
    }

    function _whenActive(plugin) {
        if (plugin.hasOwnProperty("_status")) {
            return plugin._status.whenActive();
        }

        plugin._renderManager.once("active", function () {
            _activeDeferred.resolve();
            _activeDeferred = null;
            _idleDeferred = Q.defer();
        });

        return _activeDeferred.promise;
    }

    function _whenIdle(plugin, id) {
        if (plugin.hasOwnProperty("_status")) {
            return plugin._status.whenIdle();
        }

        plugin._assetManagers[id].once("idle", function () {
            _idleDeferred.resolve();
            _idleDeferred = null;
            _activeDeferred = Q.defer();
        });

        return _idleDeferred.promise;
    }

    function _activate(plugin, documentId) {
        if (plugin.hasOwnProperty("_toggleActiveDocument")) {
            plugin._toggleActiveDocument();
            return;
        }

        plugin._stateManager.activate(documentId);
    }

    function getTestSpecForDir(baseDir) {
        return (Q.nfcall(fse.readdir, baseDir)
        .then(function (files) {
            var statPromises = files.map(function (f) {
                return Q.nfcall(fse.stat, path.resolve(baseDir, f))
                .then(function (stats) {
                    return {filename: f, stats: stats};
                });
            });

            return Q.all(statPromises);
        })
        .then(function (files) {
            var psds = [],
                directories = [],
                testFiles = [],
                test = null;

            files.forEach(function (file) {
                if (file.stats.isDirectory()) {
                    directories.push(file.filename);
                } else if (file.stats.isFile()) {
                    if (path.extname(file.filename).toLowerCase() === ".psd") {
                        psds.push(file.filename);
                    }
                }
            });

            psds.forEach(function (psd) {
                var base = path.basename(psd, path.extname(psd)),
                    i = directories.indexOf(base + OUTPUT_FOLDER_SUFFIX);
                if (i >= 0) {
                    testFiles.push({
                        input: psd,
                        output: directories[i]
                    });
                }
            });

            // Note: This function can find multiple psd/output dir pairs, which
            // we might want in the future. However, the test running code doesn't
            // support multiple PSDs per test (because the old assets plugin doesn't
            // have a good way to ensure generation is on for all of them after
            // they're opened). So, for now, we just return the first one.

            if (testFiles.length > 0) {
                test = {
                    name : path.basename(baseDir),
                    baseDir : baseDir,
                    input : testFiles[0].input,
                    output : testFiles[0].output
                };
            }

            return test;
        }));
    }

    function getTests() {
        function isDisabledTestFolderName(filename) {
            return (filename.length > DISABLED_TEST_FOLDER_SUFFIX.length &&
                filename.lastIndexOf(DISABLED_TEST_FOLDER_SUFFIX) ===
                filename.length - DISABLED_TEST_FOLDER_SUFFIX.length);
        }

        function isSelectedTest(filename) {
            // Tests are considered selected by default unless the "selected-tests" key is present in config.
            // If present, then check the list.
            return ( !_config["selected-tests"] || _config["selected-tests"].indexOf(filename) > -1 );
        }

        return (Q.nfcall(fse.readdir, path.resolve(__dirname, TEST_PATH_ROOT))
        .then(function (files) {
            var statPromises = files.map(function (f) {
                return (Q.nfcall(fse.stat, path.resolve(__dirname, TEST_PATH_ROOT, f))
                .then(function (stats) {
                    return {filename: f, stats: stats};
                }));
            });

            return Q.all(statPromises);
        })
        .then(function (files) {
            var testDirs = files.filter(function (file) {
                return ( file.stats.isDirectory() &&
                    !isDisabledTestFolderName(file.filename) &&
                    isSelectedTest(file.filename) 
                );
            });

            var testPromises = testDirs.map(function (file) {
                return getTestSpecForDir(
                    path.resolve(__dirname, TEST_PATH_ROOT, file.filename)
                );
            });
            return Q.all(testPromises);
        })
        .then(function (tests) {
            var theTests = tests.filter(function (test) {
                return test !== null;
            });
            return theTests;
        }));
    }

    function closeAllPhotoshopDocuments() {
        return _generator.evaluateJSXFile(path.resolve(__dirname, "lib/jsx/closeAll.jsx"));
    }

    function openPhotoshopDocument(documentPath) {
        return _generator.evaluateJSXFile(
            path.resolve(__dirname, "lib/jsx/openFile.jsx"),
            {filename : documentPath}
        );
    }

    function setup(test) {
        return (closeAllPhotoshopDocuments()
        .then(function () {
            if (typeof(_config["working-directory"]) === "string") {
                var workingDir = path.resolve(
                    _config["working-directory"],
                    path.basename(test.baseDir)
                );
                return (Q.nfcall(fse.mkdirs, workingDir)
                .then(function () {
                    return workingDir;
                }));
            } else {
                return (Q.nfcall(tmp.dir, {unsafeCleanup : true})
                .spread(function (workingDir) {
                    return workingDir;
                }));
            }
        })
        .then(function (workingDir) {
            test.workingDir = workingDir;

            var source = path.resolve(test.baseDir, test.input),
                dest = path.resolve(test.workingDir, test.input);

            // Copy input to temp folder
            return Q.nfcall(fse.copy, source, dest);
        })
        .then(function () {
            // Copy config to working dir
            var source = path.resolve(test.baseDir, GENERATOR_CONFIG_FILE);

            return Q.nfcall(fse.stat, source).then(function () {
                var dest = path.resolve(test.workingDir, GENERATOR_CONFIG_FILE);
                return Q.nfcall(fse.copy, source, dest);
            }, function () {
                // do nothing
            });
        })
        .then(function () {
            return test;
        }));
    }

    function getTestConfig(test) {
        var configPath = path.resolve(test.workingDir, GENERATOR_CONFIG_FILE);

        return Q.ninvoke(fse, "stat", configPath).then(function (stats) {
            if (!stats.isFile()) {
                return {};
            }

            return Q.ninvoke(fse, "readFile", configPath, { encoding: "utf8" }).then(function (data) {
                var config;

                try {
                    var obj = JSON.parse(data);

                    if (obj.hasOwnProperty(ASSETS_PLUGIN_ID)) {
                        config = obj[ASSETS_PLUGIN_ID];
                    } else {
                        config = {};
                    }
                } catch (ex) {
                    console.error("Unable to parse test config %s:", configPath, ex.message);
                    config = {};
                }

                return config;
            });
        }, function () {
            return {};
        });
    }

    function openAndGenerate(test) {
        var plugin = null,
            savedConfig = null;

        return (getAssetsPlugin()
        .then(function (thePlugin) {
            plugin = thePlugin;
            savedConfig = plugin._getConfig();

            return getTestConfig(test);
        })
        .then(function (config) {
            test.maxCompareMetric = config["max-compare-metric"] || DEFAULT_MAX_COMPARE_METRIC;

            // The default behavior is to ignore any user-defined generator-assets configurations.
            // That is, unless this parameter is set explicitly to true, we purge any generator-assets config
            // before setting the test-specfic configs.
            // But If `honor-generator-assets-config` is true, test-specific configs will overlay user-defined configs
            var keepExistingConfig = _config["honor-generator-assets-config"] === true;

            plugin._setConfig(config, keepExistingConfig);

            return openPhotoshopDocument(path.resolve(test.workingDir, test.input));
        })
        .then(function (id) {
            if (!id) {
                throw new Error("Did not get a valid document ID after opening the document");
            }
            var activePromise = _whenActive(plugin, id);

            test.documentID = id;
            _activate(plugin, id);

            return activePromise;
        })
        .then(function () {
            test.startTime = new Date();

            return _whenIdle(plugin, test.documentID);
        })
        .then(function () {
            test.stopTime = new Date();
            plugin._setConfig(savedConfig);

            return test;
        }));
    }

    function cremaTest(test) {
        return getCremaTester().then(
            (cremaTester) => {
                return cremaTester.runTest(test);
            },
            (err) => {
                console.log("SKIPPING CREMA TEST - no plugin found", err);
                return test;
            }
        );
    }

    function getAllFiles(baseDirectory, subdirs) {
        if (!Array.isArray(subdirs)) {
            throw new Error ("subdirs must be an array");
        }

        var subdirPromises = subdirs.map((subdir) => {
            var curDir = path.resolve(baseDirectory, subdir);

            return Q(Q.nfcall(fse.readdir, curDir) // jshint ignore:line
                .then(
                    function (files) {
                        var statPromises = files.map(function (f) {
                            return (Q.nfcall(fse.stat, path.resolve(curDir, f))
                            .then(function (stats) {
                                return {filename: f, stats: stats};
                            }));
                        });

                        return Q.all(statPromises);
                    },
                    function (err) {
                        if (subdir === CREMA_ASSSET_DIR) {
                            // Ignore crema asset directory if it doesn't exists
                            return [];
                        } else {
                            throw new Error("Could not read directory", curDir, err);
                        }
                    })
                .then(function (filesAndDirectories) {
                    var files = [],
                        directories = [];

                    filesAndDirectories.forEach(function (f) {
                        if (f.stats.isDirectory()) {
                            directories.push(f.filename);
                        } else if (f.stats.isFile()) {
                            files.push(path.resolve(curDir, f.filename));
                        }
                    });

                    var recursePromises = directories.map(function (d) {
                        return getAllFiles(curDir, [d]);
                    });

                    return (Q.all(recursePromises)
                    .then(function (recurseResults) {
                        return Array.prototype.concat.apply(files, recurseResults);
                    }));
                }));
        });

        // flatten the subdirs into one list
        return Q.all(subdirPromises).then((filesets) => {
            return filesets.reduce((acc, cur) => {
                return acc.concat(cur);
            }, []);
        });

    }

    function runInBatches(functions) {
        var queue = functions.concat(),
            results = [],
            running = 0,
            deferred = Q.defer();

        function runFunction(f) {
            running++;
            f().then(
                function (result) {
                    running--;
                    results.push(result);
                    if (deferred.promise.isPending()) {
                        if (queue.length > 0) {
                            runFunction(queue.pop());
                        } else if (running === 0) { // queue empty, none running
                            deferred.resolve(results);
                        }
                    }
                },
                function (err) {
                    deferred.reject(err);
                }
            );
        }

        if (queue.length === 0) {
            deferred.resolve([]);
        } else {
            queue.splice(0, MAX_CONCURRENT_COMPARE_JOBS).map(runFunction);
        }

        return deferred.promise;
    }

    function comparePixels(source, dest) {
        _logger.debug("COMPARING %s to %s", source, dest);

        return (_psExecutablePathPromise
        .then(function (psPath) {
            var execpath,
                args,
                spawnDeferred = Q.defer();

            if (process.platform === "darwin") {
                execpath = path.resolve(psPath, "convert");
            } else {
                execpath = path.resolve(psPath, "convert.exe");
            }
            
            args = [
                "(", source, "-flatten", ")",
                "(", dest, "-flatten", ")",
                "-compose", "Difference",
                "-composite",
                "-colorspace", "gray",
                "-format", "%[mean]", "info:"
            ];

            var p = childProcess.spawn(execpath, args),
                result = "",
                err = "";

            p.stdout.setEncoding("utf8");
            p.stderr.setEncoding("utf8");

            p.stdout.on("data", function (data) {
                result += data;
            });

            p.stderr.on("data", function (data) {
                err += data;
            });

            p.on("close", function (code) {
                if (code === 0) {
                    spawnDeferred.resolve(parseFloat(result));
                } else {
                    spawnDeferred.reject(err);
                }
            });

            return spawnDeferred.promise;
        }));
    }

    function compare(test) {
        var result = {
            passed : false,
            specFiles : null,
            actualFiles : null,
            errors : [],
            comparisons : []
        },
        outputDirList = [test.output];

        if (_isCremaPluginLoaded) {
            outputDirList.push( CREMA_ASSSET_DIR );
        }

        return (Q.all([
            getAllFiles(test.baseDir, outputDirList),
            getAllFiles(test.workingDir, outputDirList)
        ]).spread(function (_base, _working) {
            var toCompare = [],
                compareFunctions,
                actualFilesCopy;

            _base = _base.map((file) => path.relative(test.baseDir, file));
            _working = _working.map((file) => path.relative(test.workingDir, file));

            result.specFiles = _base.filter(function (file) {
                return !FILES_TO_IGNORE.test(file);
            });
            result.actualFiles = _working.filter(function (file) {
                return !FILES_TO_IGNORE.test(file);
            });

            actualFilesCopy = result.actualFiles.concat();

            result.specFiles.forEach(function (b) {
                var i = actualFilesCopy.indexOf(b);
                if (i < 0) {
                    result.errors.push("file " + b + " missing from output");
                } else {
                    if (path.basename(b) !== ERRORS_TXT) {
                        toCompare.push(b);
                    }
                    actualFilesCopy.splice(i, 1);
                }
            });

            actualFilesCopy.forEach(function (w) {
                result.errors.push("file " + w + " is unexpectedly in output");
            });

            compareFunctions = toCompare.map(function (f) {
                return function () {
                    return (comparePixels(
                        path.resolve(test.baseDir, f),
                        path.resolve(test.workingDir, f))
                    .then(
                        function (metric) {
                            result.comparisons.push({file : f, metric : metric});
                            if (metric > test.maxCompareMetric) {
                                result.errors.push("file " + f + " has a comparison metric of " + metric +
                                    " > " + test.maxCompareMetric);
                            }
                        },
                        function (rejection) {
                            result.comparisons.push({file : f, metric : 1000000});
                            result.errors.push("file " + f + " Failed completely during comparison:" + rejection);
                        }));
                };
            });

            return runInBatches(compareFunctions);
        })
        .then(function () {
            if (result.errors.length === 0) {
                result.passed = true;
            }
            result.time = (test.stopTime - test.startTime) / 1000;
            test.result = result;
            return test;
        }));
    }

    function teardown(test) {
        if (_config.hasOwnProperty("cleanup") && _config.cleanup === false) {
            return Q.call(undefined, test);
        } else {
            return (Q.nfcall(fse.remove, test.workingDir)
            .then(function () {
                return test;
            }));
        }
    }

    function runTest(test) {
        _logger.info("TEST RUNNING: %j", test);

        return (setup(test)
        .then(openAndGenerate)
        .then(cremaTest)
        .then(compare)
        .then(teardown)
        .then(function () {
            _logger.info("TEST COMPLETE:\n%s\n\n", JSON.stringify(test.result, null, "  "));
            return test;
        }, function (err) {
            _logger.info("TEST ERRORED:", err);
            test.result = err;
            return test;
        }));
    }

    function runAllTests() {
        _logger.info("Running all tests...");

        var allStartTime = new Date(),
            allStopTime = null;


        function summarizeResults(results) {
            var summary = "",
                passedCount = 0;

            results.forEach(function (result) {
                if (typeof(result) !== "object" || !result.hasOwnProperty("passed")) {
                    summary += "execution error: " + String(result) + "\n";
                } else if (result.passed) {
                    summary += "passed: " + result.name + " - " + result.time + " seconds\n";
                    passedCount++;
                } else {
                    summary += "failed: " + result.name + " - " + result.errors.length + " error(s)\n";
                    result.errors.forEach(function (error) {
                        summary += "   " + error + "\n";
                    });
                }
            });

            summary = passedCount + "/" + results.length + " tests passed\n\n" + summary;

            if (allStartTime && allStopTime) {
                summary += "\nTotal test time (including automation overhead): " +
                    ((allStopTime - allStartTime) / 1000) + " seconds";
            }

            return summary;
        }

        function xmlResults(results) {
            var xml = "", // this will be the individual test results
                failureCount = 0,
                errorCount = 0,
                indent = "    ",
                classname = "generatorAssetsAutomation";

            results.forEach(function (result) {
                xml += indent.repeat(2) + "<testcase classname='" + classname + "'";
                if ( typeof(result) === "object" ) {
                    xml += " name='" + result.name + "' time='" + result.time + "'";
                }
                xml += ">\n";
                if ( typeof(result) !== "object" || !result.hasOwnProperty("passed") ) {
                    xml += indent.repeat(3) + "<error>" + String(result) + "</error>\n";
                    errorCount++;
                } else if ( !result.passed ) {
                    result.errors.forEach(function (error) {
                        xml += indent.repeat(3) + "<failure message='failed'>" + error + "</failure>\n";
                    });
                    failureCount++;
                } // else result is passed
                xml += indent.repeat(2) + "</testcase>\n";
            });

            xml = "<?xml version='1.0' encoding='UTF-8'?>\n<testsuites>\n" +
                indent.repeat(1) + "<testsuite name='" + classname + "' errors='" + errorCount + "'" +
                " tests='" + results.length + "' failures='" + failureCount + "'" + 
                ( (allStartTime && allStopTime) ? " time='" + ((allStopTime - allStartTime) / 1000) + "'" : "" ) + 
                ">\n" +
                xml + 
                indent.repeat(1) + "</testsuite>\n</testsuites>";

            return xml;
        }

        var results = [];

        return (getTests()
        .then(function (theTests) {
            var testFuncs = theTests.map(function (test) {
                return function () {
                    return (runTest(test)
                    .then(function (test) {
                        var result = test.result;
                        result.name = test.name;
                        result.cremaTestDuration = test.cremaTestDuration;
                        results.push(result);
                    }));
                };
            });

            testFuncs.unshift(getAssetsPlugin);
            testFuncs.push(closeAllPhotoshopDocuments);

            return testFuncs.reduce(function (soFar, f) {
                return soFar.then(f);
            }, Q.call());
        })
        .then(function () {
            if (!!_config["results-xml-path"]) {
                var resultsXmlPath = _config["results-xml-path"];
                _logger.info("Writing XML results to:  " , resultsXmlPath);
                return Q.ninvoke(fse,"writeFile", resultsXmlPath, xmlResults(results));
            } else {
                return true ;
            }
        })
        .then(function () {
            var summary = summarizeResults(results);
            if (!!_config["results-log-path"]) {
                var resultsLogPath = _config["results-log-path"];
                _logger.info("Writing results log to:  " , resultsLogPath);

                return Q.ninvoke(fse, "writeFile", resultsLogPath, summary)
                    .thenResolve(summary);
            } else {
                return new Q(summary);
            }
        })
        .done(function (summary) {
            _logger.info("...all tests done");
            allStopTime = new Date();
            _logger.info("ALL THE RESULTS:\n%s\n\n", JSON.stringify(results, null, "  "));
            _logger.info("\n\nSUMMARY:\n\n%s\n\n", summary);
            _logger.info("Crema Times:", results.map((r) => r.name + "~" + r.cremaTestDuration));
            _logger.info("Total time spent on crema", results.reduce((v, r) => {return v + r.cremaTestDuration;}, 0));
            if (!_config.autorun) {
                var alertText = "Generator automated test summary:\n\n";
                alertText += _isCremaPluginLoaded ? "" : "CREMA PLUGIN NOT LOADED.\nCrema tests were skipped.\n\n";
                alertText += summary;
                _generator.alert(alertText);
            }
        }));
    }

    function init(generator, config, logger) {
        _generator = generator;
        _config = config;
        _logger = logger;

        _psExecutablePathPromise = _generator.getPhotoshopExecutableLocation();

        _generator.onPhotoshopEvent("generatorMenuChanged", function (e) {
            if (e.generatorMenuChanged.name === MENU_ID) {
                runAllTests();
            }
        });

        _generator.addMenuItem(
            MENU_ID,
            "Run Assets Automation",
            true,
            false
        );

        var getAssetsPluginInterval = setInterval(function () {
            var plugin = _generator.getPlugin(ASSETS_PLUGIN_ID);
            if (plugin) {
                _assetsPluginDeferred.resolve(plugin);
                clearInterval(getAssetsPluginInterval);
            }
        }, ASSETS_PLUGIN_CHECK_INTERVAL);

        var getCremaPluginInterval = setInterval(function () {
            var plugin = _generator.getPlugin(CREMA_PLUGIN_ID);
            if (plugin) {
                try {
                    var cremaTester = new CremaTester(plugin);
                    _cremaTesterDeferred.resolve(cremaTester);
                    _isCremaPluginLoaded = true;
                } catch (e) {
                    _cremaTesterDeferred.reject(e);
                }

                clearInterval(getCremaPluginInterval);
            }
        }, ASSETS_PLUGIN_CHECK_INTERVAL);

        if (_config.autorun === true) {
            runAllTests();
        }
    }

    exports.init = init;

}());
