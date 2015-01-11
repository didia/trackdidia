 /** @jsx React.DOM */
 
 /**
 * @author Thefuture2092
 *
 */

"use strict";
define(["react"], function(React) {
    var StatMixin = {
        propTypes : {
            data : React.PropTypes.object.isRequired 
        },
        getVariation: function(variation) {
            if(variation == 0){
                return '';
            }
            else if (variation < 0) {
                return <span className="variation-sign">&#65516;</span>
            }
            else {
                return <span className="variation-sign">&#65514;</span>
            }
        }

    }

    return StatMixin;

})
