'''
Created on 2014-10-28

@author: didia
'''
from google.appengine.ext import ndb

def create_user(user_id, email, nickname):
    user = User(id=user_id, email=email, nickname=nickname)
    user.put()
    return user;

def get_user(user_id):
    return User.get_by_id(user_id)

def update_user(user_id, **kargs):
    user = get_user(user_id)
    user.populate(**kargs)
    return user 
def delete_user(user_id):
    key = ndb.Key(User, user_id)
    key.delete()
    
class User(ndb.Model):
    '''
    Stores a user information
    '''
    email = ndb.StringProperty(required=True)
    nickname = ndb.StringProperty(required=True)
    
    def get_id(self):
        return self.key.id()
    def get_email(self):
        return self.email
    def get_nickname(self):
        return self.nickname
        