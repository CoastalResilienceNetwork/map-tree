﻿// Module LayerManager.js

define([
        "dojo/json",
        "use!tv4",
        "use!underscore",
        "./stripJsonComments",
        "./layerConfigSchema",
        "./AgsLoader",
        "./WmsLoader"
    ],
    function (JSON, tv4, _, stripJsonComments, layerConfigSchema, AgsLoader, WmsLoader) {

        var LayerManager = function (app) {
            var _app = app,
                _urls = [],
                _treeRootNode = null, // the absolute base of the tree
                _cssClassPrefix = 'pluginLayerSelector',
                _onLoadingComplete,
                _getUniqueFolderTitle = createFnForUniqueFolderTitles();

            
            /*
              Public Methods
             */
            this.load = loadLayerData;
            this.hideAllLayers = function (map) { hideAllLayersForNode(_treeRootNode, map); };
            this.setServiceState = function (stateObject, map) { setServiceStateForNode(_treeRootNode, stateObject, map); };
            this.getServiceState = function () { return getServiceStateForNode (_treeRootNode); };
            this.clearServiceState = function () { clearServiceStateForNode(_treeRootNode); };


            /*
              Private methods
             */
            function loadLayerData(layerSourcesJson, regionKey, onLoadingComplete) {
                var layerData = parseLayerConfigData(layerSourcesJson);

                _onLoadingComplete = onLoadingComplete;

                if (layerData) {

                    // layerData is now an array of layers to load, which may have `availableInRegion` keys
                    // which restrict what subregions they are loaded for.  If no keys are present, make
                    // no restriction.  If "main" is included in the list, the layer is available in the
                    // main region, in addtion to any listed subregions.
                    // ['a'] -> just subregion A, main
                    // ['a', 'b'] -> both A and B, not main
                    // ['b', 'main'] -> main region and B
                    // []/null/undefined -> all regions
                    var availableLayerData = _.filter(layerData, function(layer) {
                        var layerRegions;
                        if (layer.agsSource) {
                            layerRegions = layer.agsSource.availableInRegions;
                        } else if (layer.wmsSource) {
                            layerRegions = layer.wmsSource.availableInRegions;
                        }

                        return !_.any(layerRegions) || _.contains(layerRegions, regionKey);
                    });

                    _treeRootNode = makeRootNode();

                    // Load layer info from each source
                    _.each(availableLayerData, function (dataSourceContainer) {
                        var loader = null, innerContainer = null, source = null, sourceRootNode = null;

                        // initialize layer data
                        if (dataSourceContainer.agsSource) {
                            source = dataSourceContainer.agsSource;
                            _.each(source.folders, function(folder) {
                                _.each(folder.services, function(service) {
                                    var url = (_.has(folder, "url")) ? folder.url : source.url;
                                    url = (folder.name != "") ? url + "/" + folder.name : url;
                                    _urls.push(url + "/" + service.name);
                                });
                            });
                            loader = new AgsLoader(source.url);
                            innerContainer = source.folders;

                        } else if (dataSourceContainer.wmsSource) {
                            source = dataSourceContainer.wmsSource;
                            _urls.push(source.url);
                            var extent = _app._unsafeMap.extent;
                            loader = new WmsLoader(source.url, source.folderTitle, source, extent);
                            innerContainer = source.layerIds;
                        }

                        // validate and load, or raise a schema error
                        if ((dataSourceContainer.agsSource) && !(dataSourceContainer.agsSource && dataSourceContainer.wmsSource)) {
                            if (source.folderTitle === "") {
                                sourceRootNode = _treeRootNode;
                            } else {
                                sourceRootNode = makeContainerNode(source.folderTitle, "folder", _treeRootNode, source);
                            }
                            loadLayerSource(loader, source.url, sourceRootNode, innerContainer);
                        } else if ((dataSourceContainer.wmsSource) && !(dataSourceContainer.agsSource && dataSourceContainer.wmsSource)) {  
                            loadLayerSource(loader, source.url, _treeRootNode, innerContainer);
                        } else { 
                            _app.error("Schema error. Must have a single agsSource or wmsSource in each object.");
                        }

                    });
                }
            }

            function createFnForUniqueFolderTitles () {
                    var assignedNameCounter = 0, duplicateNameCounter = 1, usedNames = [],

                    innerFunction = function (serviceSource) {
                        /*
                          Takes a serviceSource, gets the folderTitle and if it 
                          is not defined, or not unique, it is assigned a unique name.
                        */

                        if (serviceSource.folderTitle === undefined) {
                            return "folder_" + ++assignedNameCounter;
                        } else if (_.contains(usedNames, serviceSource.folderTitle)) {
                            _app.error("", "Cannot have multiple top-level folders with the same name." + "Appending duplicate notice.");
                            return serviceSource.folderTitle + "_(duplicate #" + ++duplicateNameCounter + ")";
                        } else {
                            usedNames.push(serviceSource.folderTitle);
                            return serviceSource.folderTitle;
                        }
                    };

                    return innerFunction;
            }

            function parseLayerConfigData(layerSourcesJson) {
                // Parse and validate config data to get URLs of layer sources
                var errorMessage;
                try {
                    var json = stripJsonComments(layerSourcesJson),
                        data = JSON.parse(json),
                        valid = tv4.validate(data, layerConfigSchema);
                    if (valid) {
                        return data;
                    } else {
                        errorMessage = tv4.error.message + " (data path: " + tv4.error.dataPath + ")";
                    }
                } catch (e) {
                    errorMessage = e.message;
                }
                _app.error("", "Error in config file layers.json: " + errorMessage);
                return null;
            }

            function loadLayerSource(loader, url, sourceRootNode, folderOrLayerIdWhitelist) {
                //_urls.push(url);
                loader.load(sourceRootNode, folderOrLayerIdWhitelist, makeContainerNode, makeLeafNode, onLayerSourceLoaded, onLayerSourceLoadError);
            }

            function onLayerSourceLoaded(url) {
                // Specified URL is loaded; remove it from the list
                var i = _.indexOf(_urls, url);
                if (i != -1) {
                    _urls.splice(i, 1);
                }
                if (_urls.length == 0) {
                    // All URLs are loaded
                    _onLoadingComplete(_treeRootNode);
                }
            }

            function onLayerSourceLoadError(jqXHR, textStatus, errorThrown) {
                _app.error("", "AJAX request to load layer source failed: '" + (jqXHR.resultText || jqXHR)
                    + "' Status: '" + textStatus + "' Error: '" + errorThrown + "'");
            }

            // ------------------------------------------------------------------------
            // Functions to build a node tree of map layers. The node schema targets Ext.data.TreeStore 
            // and Ext.tree.Panel, but should be generic enough for other UI frameworks.

            function makeRootNode() {
                var node = {
                    name: 'root',
                    expanded: true,
                    children: []
                };
                return node;
            }

            function makeContainerNode(name, type, parentNode, config){
                var node = {
                    type: type,
                    cls: _cssClassPrefix + "-" + type, // When the tree is displayed the node's associated DOM element will have this CSS class
                    text: name ? name.replace(/_/g, " ") : "",
                    leaf: false,
                    children: [],
                    parent: parentNode,
                    isNew: config ? config.isNew : undefined
                };
                node.name = nodeUid(node);
                // TODO - I don't know why this was necessary. If parent node is defined,
                // it should always have an array assigned to children. However, when
                // modifying layers.json to only include AGS sources, this error came up.
                if (parentNode.children) {
                    parentNode.children.push(node);
                }
                return node;
            }

            function makeLeafNode(title, layerId, showOrHideLayer, parentNode, config) {
                var node = {
                    type: "layer",
                    cls: _cssClassPrefix + "-layer", // When the tree is displayed the node's associated DOM element will have this CSS class
                    text: title.replace(/_/g, " "),
                    leaf: true,
                    checked: false,
                    layerId: layerId,
                    parent: parentNode,
                    showOrHideLayer: showOrHideLayer, // function which shows or hides the layer
                    isNew: config ? config.isNew : undefined,
                    downloadUrl: config ? config.downloadUrl : undefined
                };
				if (_.has(config,"visibleSubLayerIds")) { node.visibleSubLayerIds = config.visibleSubLayerIds;  }
                if (!parentNode.children) { parentNode.children = []; }
                parentNode.children.push(node);
                return node;
            }

           function nodeUid(node) {
                if (node === _treeRootNode) {
                    return 'root';
                } else if (node.parent) {
                    return nodeUid(node.parent) + '/' + node.text;
                }
                return node.text;
            }

            function hideAllLayersForNode(node, map) {
                if (node.hideAllLayers) {
                    node.hideAllLayers(node, map);
                } else {
                    _.each(node.children, function (child) {
                        hideAllLayersForNode(child, map);
                    });
                }
            }

            function setServiceStateForNode (node, stateObject, map) {
                if (node.setServiceState) {
                    node.setServiceState(node, stateObject, map);
                } else {
                    _.each(node.children, function (child) {
                        setServiceStateForNode(child, stateObject, map);
                    });
                }
            }

            function getServiceStateForNode (rootNode) {
                var stateObject = {};

                function saveServiceStateForNodeInner (node, stateObject) {
                    if (node.saveServiceState) {
                        node.saveServiceState(node, stateObject);
                    } else {
                        _.each(node.children, function (child) {
                            saveServiceStateForNodeInner(child, stateObject);
                        });
                    }
                }
                saveServiceStateForNodeInner(rootNode, stateObject);
                return stateObject;
            }

            function clearServiceStateForNode(node) {
                // You don't want to collapse the root node or nothing will be visible.
                if (node !== _treeRootNode) {
                    node.checked = false;
                    node.expanded = false;
                }
                _.each(node.children, clearServiceStateForNode);
            }
        };
        return LayerManager;
    }
);
