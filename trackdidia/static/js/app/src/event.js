/** @jsx React.DOM */
define(["app/exceptions"], function(exceptions){
	
	return {
        
        clear: function(name) {
            delete this.subscribers()[name];
        },

        fire: function() {
            try{
                var
                    args = Array.prototype.slice.call(arguments),
                    name = args.shift();
                console.log("Firing event: " + name);
                this.subscribers()[name].forEach(function(sub) {
                    if (sub) {
                        sub.apply(this, args);
                    }
                });
            } catch(e){
                if(e instanceof exceptions.LoginException) {
                    
                    console.log(e.message);
                }
                else {
                    throw e;
                }
            } 
            
        },

        monitor: function(name, callback) {
            if (!callback()) {
              var
                ctx = this,
                fn = function() {
                  if (callback.apply(callback, arguments)) {
                    ctx.unsubscribe(name, fn);
                  }
                };
        
              this.subscribe(name, fn);
            }
        },  

        _bind : function(toObject, methodName) {
            return function(){toObject[methodName](Array.prototype.slice.call(arguments))};
        },

        subscribe: function(name, cb, toObject) {

            var subs = this.subscribers();
            
            if(toObject != null && typeof toObject != "undefined") {
                cb = this._bind(toObject, cb);
            }

            if (!subs[name]) {
                subs[name] = [cb];
            } 
            else {
                subs[name].push(cb);
            }
        },

        subscribers: function() {
			  
			if (!this._subscribersMap) {
			  this._subscribersMap = {};
			}
			return this._subscribersMap;
		  },
		 

		  
        unsubscribe: function(name, cb, toObject) {
        	var subs = this.subscribers()[name];
        	console.log(subs);
            if(toObject != null && typeof toObject != "undefined") {
                cb = this._bind(toObject, cb);
            }
        	subs.forEach(function(value, key) {
        		if (value == cb) {
        		  console.log("Unsubscribing from " + name);
        		  subs[key] = null;
        		}
        	});
        	}
		
			
	}
	
});// JavaScript Document